import { createHash, randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { AbiCoder, formatEther, keccak256 } from "ethers";
import { normalizeAddress, parseAmountEth, validateMemo } from "@aichainpay/shared";
import type { Config } from "../config.js";
import type { Principal } from "../auth/oauth.js";
import type { ChainService } from "../blockchain/index.js";

export type PaymentRequestRow = {
  id: string; owner: string; client_id: string; client_request_id: string; payload_hash: string;
  request_id_bytes32: string; intent_digest: string; agent: string; chain_id: number; contract_address: string;
  recipient: string; amount_wei: string; memo: string; permission_epoch: string; deadline: number;
  state: string; tx_hash: string | null; created_at: number; updated_at: number;
};

export function requestForPrincipal(db: Database.Database, principal: Principal, id: string): PaymentRequestRow | undefined {
  return db.prepare("SELECT * FROM payment_requests WHERE id=? AND owner=? AND client_id=?").get(id, principal.address, principal.clientId) as PaymentRequestRow | undefined;
}

export function preview(row: PaymentRequestRow) {
  return {
    request_id: row.id,
    intent_digest: row.intent_digest,
    source: "AIChainPay vault (not ordinary MetaMask wallet)",
    owner: row.owner,
    agent: row.agent,
    network: row.chain_id === 11155111 ? "Sepolia" : "Explicit local test chain",
    chain_id: row.chain_id,
    contract: row.contract_address,
    recipient: row.recipient,
    amount_eth: formatEther(BigInt(row.amount_wei)),
    amount_wei: row.amount_wei,
    memo: row.memo,
    permission_epoch: row.permission_epoch,
    request_deadline: new Date(row.deadline * 1000).toISOString(),
    gas_payer: "Dedicated agent account",
    state: row.state,
    transaction_hash: row.tx_hash,
  };
}

/** Bind every human-readable execution argument to the persisted immutable intent. */
export function assertExecutionDetails(row: PaymentRequestRow, details: {
  source: string; owner: string; chain_id: number; contract: string;
  recipient: string; amount_eth: string; memo: string; request_deadline: string;
}): void {
  const expected = preview(row);
  for (const key of ["source", "owner", "chain_id", "contract", "recipient", "amount_eth", "memo", "request_deadline"] as const) {
    if (details[key] !== expected[key]) throw new Error(`Execution ${key} does not match the prepared payment`);
  }
}

export async function preparePayment(db: Database.Database, config: Config, chain: ChainService, principal: Principal, input: { recipient: string; amount_eth: string; memo?: string; client_request_id: string }) {
  if (!principal.scopes.has("payments:prepare")) throw new Error("Missing payments:prepare scope");
  if (!config.agentAddress) throw new Error("Agent address is not configured");
  const recipient = normalizeAddress(input.recipient);
  const amountWei = parseAmountEth(input.amount_eth);
  const memo = validateMemo(input.memo ?? "");
  if (recipient === principal.address || recipient === config.contractAddress) throw new Error("Recipient cannot be owner or vault");
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(input.client_request_id)) throw new Error("client_request_id must be 8-100 URL-safe characters");
  const payloadHash = createHash("sha256").update(JSON.stringify([recipient, amountWei.toString(), memo])).digest("hex");
  const existing = db.prepare("SELECT * FROM payment_requests WHERE owner=? AND client_id=? AND client_request_id=?").get(principal.address, principal.clientId, input.client_request_id) as PaymentRequestRow | undefined;
  if (existing) {
    if (existing.payload_hash !== payloadHash) throw new Error("Idempotency key conflicts with a different payment");
    return preview(existing);
  }
  await chain.check();
  const permission = await chain.permission(principal.address, config.agentAddress);
  const now = Math.floor(Date.now() / 1000);
  if (!permission.active) throw new Error("Agent permission is inactive or revoked");
  if (permission.expiresAt <= now) throw new Error("Agent permission has expired");
  if (amountWei > permission.maxPerPayment) throw new Error("Amount exceeds per-payment cap");
  if (amountWei > permission.remainingAllowance) throw new Error("Amount exceeds remaining allowance");
  if (amountWei > await chain.balance(principal.address)) throw new Error("Insufficient vault balance");
  if (!await chain.allowed(principal.address, config.agentAddress, recipient)) throw new Error("Recipient is not allowed by the current grant");
  const deadline = Math.min(now + config.requestTtlSeconds, permission.expiresAt - 1);
  if (deadline <= now) throw new Error("Permission expires too soon");
  const requestIdBytes32 = `0x${randomBytes(32).toString("hex")}`;
  const digest = keccak256(AbiCoder.defaultAbiCoder().encode(
    ["address", "address", "uint256", "address", "address", "uint256", "string", "bytes32", "uint256", "uint64"],
    [principal.address, config.agentAddress, config.chainId, config.contractAddress, recipient, amountWei, memo, requestIdBytes32, permission.epoch, deadline],
  ));
  const id = randomUUID();
  try {
    db.prepare(`INSERT INTO payment_requests(id,owner,client_id,client_request_id,payload_hash,request_id_bytes32,intent_digest,agent,chain_id,contract_address,recipient,amount_wei,memo,permission_epoch,deadline,state,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, principal.address, principal.clientId, input.client_request_id, payloadHash, requestIdBytes32, digest, config.agentAddress, config.chainId, config.contractAddress, recipient, amountWei.toString(), memo, permission.epoch.toString(), deadline, "prepared", now, now);
  } catch (error) {
    const raced = db.prepare("SELECT * FROM payment_requests WHERE owner=? AND client_id=? AND client_request_id=?").get(principal.address, principal.clientId, input.client_request_id) as PaymentRequestRow | undefined;
    if (raced && raced.payload_hash === payloadHash) return preview(raced);
    throw error;
  }
  return preview(requestForPrincipal(db, principal, id)!);
}

export function cancelPayment(db: Database.Database, principal: Principal, id: string) {
  const now = Math.floor(Date.now() / 1000);
  const result = db.prepare("UPDATE payment_requests SET state='cancelled',updated_at=? WHERE id=? AND owner=? AND client_id=? AND state='prepared'").run(now, id, principal.address, principal.clientId);
  if (result.changes !== 1) throw new Error("Request not found or no longer cancellable");
  return preview(requestForPrincipal(db, principal, id)!);
}
