import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { Contract, Transaction, Wallet, formatEther } from "ethers";
import { VAULT_ABI } from "@aichainpay/shared";
import type { Config } from "../config.js";
import type { Principal } from "../auth/oauth.js";
import type { ChainService } from "../blockchain/index.js";
import { preview, requestForPrincipal, type PaymentRequestRow } from "./prepare.js";

export type ConfirmationResult = { category: "accepted" | "declined" | "cancelled" | "unsupported" | "timeout"; route: string };
export type ConfirmationAdapter = (row: PaymentRequestRow, principal: Principal) => Promise<ConfirmationResult>;
type AttemptRow = { nonce: number; tx_hash: string; signed_payload: string; state: string; receipt_block_hash: string | null; receipt_block_number: number | null };

function cipherKey(secret: string): Buffer { return createHash("sha256").update("AIChainPay signed transaction v1\0").update(secret).digest(); }
function encryptSigned(secret: string, raw: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", cipherKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(raw, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}
function decryptSigned(secret: string, stored: string): string {
  const bytes = Buffer.from(stored, "base64");
  const decipher = createDecipheriv("aes-256-gcm", cipherKey(secret), bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
}

/** One writer/instance. SQLite CAS and nonce uniqueness are the durable duplicate barriers. */
export class ExecutionService {
  private queue: Promise<unknown> = Promise.resolve();
  private wallet?: Wallet;

  constructor(private readonly db: Database.Database, private readonly config: Config, private readonly chain: ChainService, private readonly confirmation: ConfirmationAdapter) {
    if (config.agentKey) this.wallet = new Wallet(config.agentKey, chain.provider);
  }

  private serialized<T>(run: () => Promise<T>): Promise<T> {
    const current = this.queue.then(run, run);
    this.queue = current.then(() => undefined, () => undefined);
    return current;
  }

  async execute(principal: Principal, id: string, digest: string) {
    if (!principal.scopes.has("payments:execute")) throw new Error("Missing payments:execute scope");
    if (!this.wallet) throw new Error("Dedicated agent signer is unavailable");
    const row = requestForPrincipal(this.db, principal, id);
    if (!row) throw new Error("Request not found for this wallet and OAuth client");
    if (row.intent_digest !== digest) throw new Error("Intent digest mismatch");
    if (["confirming", "signing", "signed", "submitted", "confirmed", "reverted", "reconciliation_required"].includes(row.state)) return this.status(principal, id);
    if (row.state !== "prepared") throw new Error(`Request cannot execute from ${row.state}`);
    const now = Math.floor(Date.now() / 1000);
    if (row.deadline <= now) {
      this.db.prepare("UPDATE payment_requests SET state='expired',updated_at=? WHERE id=? AND state='prepared'").run(now, id);
      throw new Error("Payment intent expired");
    }
    const claim = randomUUID();
    const acquired = this.db.prepare("UPDATE payment_requests SET state='confirming',claim_token=?,claim_expires_at=?,updated_at=? WHERE id=? AND owner=? AND client_id=? AND state='prepared'").run(claim, now + 120, now, id, principal.address, principal.clientId);
    if (acquired.changes !== 1) return this.status(principal, id);
    let decision: ConfirmationResult;
    try { decision = await this.confirmation(row, principal); }
    catch { decision = { category: "unsupported", route: "adapter_error" }; }
    if (decision.category !== "accepted") {
      this.db.prepare("UPDATE payment_requests SET state='rejected',confirmation_route=?,confirmation_category=?,claim_token=NULL,claim_expires_at=NULL,updated_at=? WHERE id=? AND state='confirming' AND claim_token=?")
        .run(decision.route, decision.category, Math.floor(Date.now() / 1000), id, claim);
      throw new Error(`In-chat execution confirmation ${decision.category}; no transaction signed or broadcast`);
    }
    const moved = this.db.prepare("UPDATE payment_requests SET state='signing',confirmation_route=?,confirmation_category=?,claim_expires_at=?,updated_at=? WHERE id=? AND state='confirming' AND claim_token=?")
      .run(decision.route, decision.category, Math.floor(Date.now() / 1000) + 120, Math.floor(Date.now() / 1000), id, claim);
    if (moved.changes !== 1) throw new Error("Execution claim changed before signing");
    return this.serialized(async () => {
      try { return await this.signAndBroadcast(principal, id, claim); }
      catch (error) {
        const attempt = this.db.prepare("SELECT tx_hash FROM transaction_attempts WHERE request_id=?").get(id);
        if (!attempt) this.db.prepare("UPDATE payment_requests SET state='rejected',confirmation_category='preflight_failed',claim_token=NULL,claim_expires_at=NULL,updated_at=? WHERE id=? AND state='signing' AND claim_token=?").run(Math.floor(Date.now() / 1000), id, claim);
        throw error;
      }
    });
  }

  private async signAndBroadcast(principal: Principal, id: string, claim: string) {
    const row = requestForPrincipal(this.db, principal, id)!;
    const wallet = this.wallet!;
    const now = Math.floor(Date.now() / 1000);
    if (row.deadline <= now) throw new Error("Payment intent expired before signing");
    await this.chain.check();
    const permission = await this.chain.permission(row.owner, wallet.address);
    if (!permission.active || permission.expiresAt <= now || permission.epoch.toString() !== row.permission_epoch) throw new Error("Agent grant revoked, expired or replaced");
    const amount = BigInt(row.amount_wei);
    if (amount > permission.maxPerPayment || amount > permission.remainingAllowance) throw new Error("Agent allowance or payment cap changed");
    if (amount > await this.chain.balance(row.owner)) throw new Error("Insufficient vault balance");
    if (!await this.chain.allowed(row.owner, wallet.address, row.recipient)) throw new Error("Recipient no longer allowed");
    const args = [row.owner, row.recipient, amount, row.memo, row.request_id_bytes32, BigInt(row.permission_epoch), row.deadline] as const;
    const contract = new Contract(this.config.contractAddress, VAULT_ABI, wallet);
    await contract.executeAgentPayment.staticCall(...args);
    const data = this.chain.iface.encodeFunctionData("executeAgentPayment", args);
    const estimate = await this.chain.provider.estimateGas({ from: wallet.address, to: this.config.contractAddress, data });
    const gasLimit = estimate * 12n / 10n + 10_000n;
    const fees = await this.chain.provider.getFeeData();
    const maxPriorityFeePerGas = fees.maxPriorityFeePerGas ?? fees.gasPrice ?? 1_000_000_000n;
    const maxFeePerGas = fees.maxFeePerGas ?? fees.gasPrice ?? maxPriorityFeePerGas * 2n;
    if (await this.chain.provider.getBalance(wallet.address) < gasLimit * maxFeePerGas) throw new Error("Dedicated agent lacks ETH for gas");
    const pending = await this.chain.provider.getTransactionCount(wallet.address, "pending");
    const maxRecorded = this.db.prepare("SELECT MAX(nonce) AS max_nonce FROM transaction_attempts").get() as { max_nonce: number | null };
    if (maxRecorded.max_nonce !== null && pending > maxRecorded.max_nonce + 1) throw new Error("External agent nonce use detected; reconcile before continuing");
    const nonce = Math.max(pending, (maxRecorded.max_nonce ?? -1) + 1);
    const raw = await wallet.signTransaction({ type: 2, chainId: this.config.chainId, nonce, to: this.config.contractAddress, data, value: 0n, gasLimit, maxFeePerGas, maxPriorityFeePerGas });
    const hash = Transaction.from(raw).hash;
    if (!hash) throw new Error("Could not derive signed transaction hash");
    const stored = encryptSigned(this.config.sessionSecret, raw);
    this.db.transaction(() => {
      const current = this.db.prepare("SELECT state,claim_token FROM payment_requests WHERE id=?").get(id) as { state: string; claim_token: string };
      if (current.state !== "signing" || current.claim_token !== claim) throw new Error("Execution claim lost");
      this.db.prepare("INSERT INTO transaction_attempts(request_id,nonce,tx_hash,signed_payload,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
        .run(id, nonce, hash, stored, "signed", now, now);
      this.db.prepare("UPDATE payment_requests SET state='signed',tx_hash=?,updated_at=? WHERE id=? AND state='signing' AND claim_token=?").run(hash, now, id, claim);
    })();
    await this.broadcastStored(id, hash, raw);
    return this.status(principal, id);
  }

  private async broadcastStored(id: string, hash: string, raw: string) {
    try {
      const sent = await this.chain.provider.broadcastTransaction(raw);
      if (sent.hash.toLowerCase() !== hash.toLowerCase()) throw new Error("RPC returned an unexpected transaction hash");
    } catch {
      // A timeout or 'already known' is uncertain. The identical signed bytes
      // remain durable and can be rebroadcast; never create a new payment.
      if (!await this.chain.provider.getTransaction(hash)) return;
    }
    const now = Math.floor(Date.now() / 1000);
    this.db.prepare("UPDATE transaction_attempts SET state='submitted',updated_at=? WHERE request_id=? AND tx_hash=?").run(now, id, hash);
    this.db.prepare("UPDATE payment_requests SET state='submitted',updated_at=? WHERE id=? AND state='signed'").run(now, id);
  }

  async status(principal: Principal, id: string) {
    const row = requestForPrincipal(this.db, principal, id);
    if (!row) throw new Error("Request not found");
    if (row.state === "prepared" && row.deadline <= Math.floor(Date.now() / 1000)) {
      this.db.prepare("UPDATE payment_requests SET state='expired',updated_at=? WHERE id=? AND state='prepared' AND tx_hash IS NULL")
        .run(Math.floor(Date.now() / 1000), id);
    }
    if (["signed", "submitted", "confirmed", "reconciliation_required"].includes(row.state)) await this.reconcile(row);
    const current = requestForPrincipal(this.db, principal, id)!;
    const receipt = current.tx_hash ? await this.chain.provider.getTransactionReceipt(current.tx_hash) : null;
    const block = receipt ? await this.chain.provider.getBlockNumber() : null;
    return { ...preview(current), confirmations: receipt && block !== null ? block - receipt.blockNumber + 1 : 0,
      required_confirmations: this.config.requiredConfirmations,
      explorer_url: current.tx_hash && this.config.chainId === 11155111 ? `https://sepolia.etherscan.io/tx/${current.tx_hash}` : null };
  }

  private async reconcile(row: PaymentRequestRow) {
    if (!row.tx_hash) return;
    const attempt = this.db.prepare("SELECT * FROM transaction_attempts WHERE request_id=? AND tx_hash=?").get(row.id, row.tx_hash) as AttemptRow | undefined;
    if (!attempt) { this.setState(row.id, "reconciliation_required"); return; }
    const receipt = await this.chain.provider.getTransactionReceipt(row.tx_hash);
    if (!receipt) {
      if (row.state === "confirmed" || attempt.receipt_block_hash) this.setState(row.id, "reconciliation_required");
      return;
    }
    const tx = await this.chain.provider.getTransaction(row.tx_hash);
    if (!tx || Number(tx.chainId) !== row.chain_id || tx.to?.toLowerCase() !== row.contract_address.toLowerCase() || tx.from.toLowerCase() !== row.agent.toLowerCase() || tx.nonce !== attempt.nonce) {
      this.setState(row.id, "reconciliation_required"); return;
    }
    // A successful receipt alone does not prove that the stored intent was
    // executed. Verify the transaction's exact call and zero ETH value.
    try {
      const call = this.chain.iface.parseTransaction({ data: tx.data, value: tx.value });
      if (!call || call.name !== "executeAgentPayment" || tx.value !== 0n ||
          call.args.owner.toLowerCase() !== row.owner.toLowerCase() ||
          call.args.recipient.toLowerCase() !== row.recipient.toLowerCase() ||
          BigInt(call.args.amount) !== BigInt(row.amount_wei) ||
          call.args.memo !== row.memo ||
          call.args.requestId.toLowerCase() !== row.request_id_bytes32.toLowerCase() ||
          BigInt(call.args.permissionEpoch) !== BigInt(row.permission_epoch) ||
          Number(call.args.requestDeadline) !== row.deadline) {
        this.setState(row.id, "reconciliation_required"); return;
      }
    } catch { this.setState(row.id, "reconciliation_required"); return; }
    if (receipt.status === 0) { this.setState(row.id, "reverted"); return; }
    if (attempt.receipt_block_hash && attempt.receipt_block_hash !== receipt.blockHash) { this.setState(row.id, "reconciliation_required"); return; }
    const matches = receipt.logs.some(log => {
      if (log.address.toLowerCase() !== row.contract_address.toLowerCase()) return false;
      try {
        const event = this.chain.iface.parseLog(log);
        return event?.name === "PaymentExecuted" && event.args.owner.toLowerCase() === row.owner.toLowerCase() && event.args.recipient.toLowerCase() === row.recipient.toLowerCase() && event.args.requestId.toLowerCase() === row.request_id_bytes32.toLowerCase() && event.args.executor.toLowerCase() === row.agent.toLowerCase() && BigInt(event.args.amount) === BigInt(row.amount_wei) && event.args.memo === row.memo;
      } catch { return false; }
    });
    if (!matches) { this.setState(row.id, "reconciliation_required"); return; }
    this.db.prepare("UPDATE transaction_attempts SET receipt_block_hash=?,receipt_block_number=?,state='mined',updated_at=? WHERE request_id=?")
      .run(receipt.blockHash, receipt.blockNumber, Math.floor(Date.now() / 1000), row.id);
    const confirmations = await this.chain.provider.getBlockNumber() - receipt.blockNumber + 1;
    this.setState(row.id, confirmations >= this.config.requiredConfirmations ? "confirmed" : "submitted");
  }

  private setState(id: string, state: string) {
    this.db.prepare("UPDATE payment_requests SET state=?,updated_at=? WHERE id=?").run(state, Math.floor(Date.now() / 1000), id);
  }

  async recover() {
    const now = Math.floor(Date.now() / 1000);
    this.db.prepare("UPDATE payment_requests SET state='prepared',claim_token=NULL,claim_expires_at=NULL WHERE state IN ('confirming','signing') AND claim_expires_at<? AND deadline>=? AND id NOT IN (SELECT request_id FROM transaction_attempts)").run(now, now);
    this.db.prepare("UPDATE payment_requests SET state='expired' WHERE state IN ('prepared','confirming','signing') AND deadline<? AND id NOT IN (SELECT request_id FROM transaction_attempts)").run(now);
    const rows = this.db.prepare("SELECT * FROM payment_requests WHERE state IN ('signed','submitted','reconciliation_required','confirmed') AND tx_hash IS NOT NULL").all() as PaymentRequestRow[];
    for (const row of rows) {
      await this.reconcile(row);
      const attempt = this.db.prepare("SELECT * FROM transaction_attempts WHERE request_id=?").get(row.id) as AttemptRow | undefined;
      if (!attempt || !["signed", "submitted"].includes(row.state)) continue;
      if (!await this.chain.provider.getTransaction(attempt.tx_hash)) await this.broadcastStored(row.id, attempt.tx_hash, decryptSigned(this.config.sessionSecret, attempt.signed_payload));
    }
  }
}

export function chatGptNativeConfirmation(config: Config): ConfirmationAdapter {
  return async (_row, principal) => {
    if (config.confirmationAdapter !== "chatgpt_native" || !/^https:\/\/chatgpt\.com\/oauth\/(?:client\.json|[^/]+\/client\.json)$/.test(principal.clientId)) {
      return { category: "unsupported", route: "disabled_or_unrecognized_client" };
    }
    // The client gates this write tool before invocation. No cryptographic
    // approval receipt is exposed to this server; record the trust boundary.
    return { category: "accepted", route: "chatgpt_native_write_confirmation_trusted" };
  };
}
