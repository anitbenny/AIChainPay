import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { Contract, JsonRpcProvider, Wallet, parseEther } from "ethers";
import { VAULT_ABI } from "@aichainpay/shared";
import { migrate } from "../connector/src/db/index.js";
import { ChainService } from "../connector/src/blockchain/index.js";
import { preparePayment, requestForPrincipal } from "../connector/src/payments/prepare.js";
import { ExecutionService } from "../connector/src/payments/execute.js";
import type { Config } from "../connector/src/config.js";
import type { Principal } from "../connector/src/auth/oauth.js";

async function main() {
  const rpc = new JsonRpcProvider("http://127.0.0.1:8545");
  const owner = await rpc.getSigner(0);
  const recipient = await rpc.getSigner(1);
  const agent = Wallet.createRandom().connect(rpc);
  const ownerAddress = await owner.getAddress();
  const recipientAddress = await recipient.getAddress();
  const vaultAddress = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
  const vault = new Contract(vaultAddress, VAULT_ABI, owner);
  await (await owner.sendTransaction({ to: agent.address, value: parseEther("0.01") })).wait();
  if (await vault.getBalance(ownerAddress) < parseEther("0.01")) await (await vault.deposit({ value: parseEther("0.02") })).wait();
  await (await vault.grantAgent(agent.address, parseEther("0.01"), parseEther("0.005"), Math.floor(Date.now() / 1000) + 3600, [])).wait();
  const db = new Database(":memory:");
  migrate(db);
  db.prepare("INSERT INTO users(address,created_at) VALUES(?,?)").run(ownerAddress, Date.now());
  const config: Config = { chainId: 31337, rpcUrl: "http://127.0.0.1:8545", contractAddress: vaultAddress, deploymentBlock: 1,
    agentKey: agent.privateKey, agentAddress: agent.address, databasePath: ":memory:", publicBaseUrl: "http://localhost:3000", issuer: "http://localhost:3000",
    sessionSecret: "local-test-only-not-a-production-secret-1234567890", confirmationAdapter: "disabled", requestTtlSeconds: 600, requiredConfirmations: 2, port: 3000 };
  const principal: Principal = { address: ownerAddress, clientId: "local-controlled-test", scopes: new Set(["wallet:read", "payments:prepare", "payments:execute"]) };
  const chain = new ChainService(config);
  const approved = new ExecutionService(db, config, chain, async () => ({ category: "accepted", route: "controlled_local_test_only" }));
  const beforeRecipient = await rpc.getBalance(recipientAddress);
  const prepared = await preparePayment(db, config, chain, principal, { recipient: recipientAddress, amount_eth: "0.001", memo: "local test", client_request_id: randomUUID() });
  const first = await approved.execute(principal, prepared.request_id, prepared.intent_digest);
  if (!first.transaction_hash) throw new Error("Local signed transaction not persisted");
  const firstReceipt = await rpc.waitForTransaction(first.transaction_hash, 1, 15_000);
  if (!firstReceipt) throw new Error("Local first transaction receipt timed out");
  await rpc.send("evm_mine", []);
  const confirmed = await approved.status(principal, prepared.request_id);
  if (confirmed.state !== "confirmed") throw new Error(`Expected confirmed local receipt, got initial=${first.state}, later=${confirmed.state}, confirmations=${confirmed.confirmations}`);
  if (await rpc.getBalance(recipientAddress) - beforeRecipient !== parseEther("0.001")) throw new Error("Recipient did not receive exact ETH");
  if ((await vault.getAgentPermission(ownerAddress, agent.address)).remainingAllowance !== parseEther("0.009")) throw new Error("Allowance did not decrease exactly");
  const retry = await approved.execute(principal, prepared.request_id, prepared.intent_digest);
  if (retry.transaction_hash !== first.transaction_hash) throw new Error("Retry created a different transaction");

  const rejected = new ExecutionService(db, config, chain, async () => ({ category: "declined", route: "controlled_local_test_only" }));
  const declinedIntent = await preparePayment(db, config, chain, principal, { recipient: recipientAddress, amount_eth: "0.001", client_request_id: randomUUID() });
  const attemptsBefore = (db.prepare("SELECT COUNT(*) count FROM transaction_attempts").get() as { count: number }).count;
  try { await rejected.execute(principal, declinedIntent.request_id, declinedIntent.intent_digest); throw new Error("Decline was accepted"); }
  catch (error) { if (!(error instanceof Error) || !error.message.includes("declined")) throw error; }
  if ((db.prepare("SELECT COUNT(*) count FROM transaction_attempts").get() as { count: number }).count !== attemptsBefore) throw new Error("Decline caused a transaction attempt");

  const pendingIntent = await preparePayment(db, config, chain, principal, { recipient: recipientAddress, amount_eth: "0.001", client_request_id: randomUUID() });
  const originalBroadcast = chain.provider.broadcastTransaction.bind(chain.provider);
  (chain.provider as unknown as { broadcastTransaction: typeof originalBroadcast }).broadcastTransaction = async () => { throw new Error("Simulated transport timeout before broadcast"); };
  const signed = await approved.execute(principal, pendingIntent.request_id, pendingIntent.intent_digest);
  if (signed.state !== "signed" || !signed.transaction_hash) throw new Error("Signed-before-broadcast state not durable");
  (chain.provider as unknown as { broadcastTransaction: typeof originalBroadcast }).broadcastTransaction = originalBroadcast;
  const restarted = new ExecutionService(db, config, chain, async () => ({ category: "unsupported", route: "should_not_reconfirm" }));
  await restarted.recover();
  const recoveredReceipt = await rpc.waitForTransaction(signed.transaction_hash, 1, 15_000);
  if (!recoveredReceipt) throw new Error("Recovered signed transaction receipt timed out");
  await rpc.send("evm_mine", []);
  const recovered = await restarted.status(principal, pendingIntent.request_id);
  if (recovered.state !== "confirmed" || recovered.transaction_hash !== signed.transaction_hash) throw new Error("Identical signed transaction was not recovered");
  if (requestForPrincipal(db, principal, declinedIntent.request_id)?.state !== "rejected") throw new Error("Declined request state changed");

  const concurrentA = await preparePayment(db, config, chain, principal, { recipient: recipientAddress, amount_eth: "0.001", client_request_id: randomUUID() });
  const concurrentB = await preparePayment(db, config, chain, principal, { recipient: recipientAddress, amount_eth: "0.001", client_request_id: randomUUID() });
  const [sameA, sameRetry, separate] = await Promise.all([
    approved.execute(principal, concurrentA.request_id, concurrentA.intent_digest),
    approved.execute(principal, concurrentA.request_id, concurrentA.intent_digest),
    approved.execute(principal, concurrentB.request_id, concurrentB.intent_digest),
  ]);
  if (!sameA.transaction_hash || !separate.transaction_hash) throw new Error("Concurrent payments were not signed");
  if (sameRetry.transaction_hash && sameRetry.transaction_hash !== sameA.transaction_hash) throw new Error("Concurrent retry changed transaction hash");
  await rpc.waitForTransaction(sameA.transaction_hash, 1, 15_000);
  await rpc.waitForTransaction(separate.transaction_hash, 1, 15_000);
  await rpc.send("evm_mine", []);
  if ((await approved.status(principal, concurrentA.request_id)).state !== "confirmed" || (await approved.status(principal, concurrentB.request_id)).state !== "confirmed") throw new Error("Concurrent payments did not reconcile");
  const attempts = db.prepare("SELECT request_id,nonce,tx_hash FROM transaction_attempts ORDER BY nonce").all() as { request_id: string; nonce: number; tx_hash: string }[];
  if (attempts.length !== 4 || new Set(attempts.map(row => row.nonce)).size !== 4) throw new Error("Concurrent requests reused an agent nonce or duplicated an attempt");
  if (attempts.filter(row => row.request_id === concurrentA.request_id).length !== 1) throw new Error("Same-request concurrency created duplicate attempts");

  // Simulate a process crash after RPC accepted a signed transaction but before
  // its submitted status was durably stored. Recovery must not sign a new one.
  db.prepare("UPDATE payment_requests SET state='signed' WHERE id=?").run(concurrentB.request_id);
  db.prepare("UPDATE transaction_attempts SET state='signed' WHERE request_id=?").run(concurrentB.request_id);
  await restarted.recover();
  const afterBroadcastCrash = await restarted.status(principal, concurrentB.request_id);
  if (afterBroadcastCrash.state !== "confirmed" || afterBroadcastCrash.transaction_hash !== separate.transaction_hash) throw new Error("Broadcast-before-status recovery changed transaction or failed reconciliation");
  if ((await rpc.getBalance(recipientAddress)) - beforeRecipient !== parseEther("0.004")) throw new Error("Concurrent recipient total was not exact");

  console.log(JSON.stringify({ chain_id: 31337, confirmation_adapter: "controlled test stub, not a chat client", direct_recipient_delta_wei: parseEther("0.004").toString(),
    first_transaction: first.transaction_hash, recovered_transaction: recovered.transaction_hash, declined_broadcasts: 0,
    signed_before_broadcast_recovery: "passed", broadcast_before_status_recovery: "passed", concurrent_nonce_uniqueness: "passed", same_request_single_attempt: "passed", idempotent_retry: "same hash", receipt_event_verification: "passed" }, null, 2));
  db.close();
}

main().catch(error => { console.error(error instanceof Error ? error.message : "Local execution test failed"); process.exitCode = 1; });
