import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { Wallet, parseEther } from "ethers";
import { migrate } from "../src/db/index.js";
import { createChallenge, verifyLogin } from "../src/auth/siwe.js";
import { verifyBearer, type Principal } from "../src/auth/oauth.js";
import { cancelPayment, preparePayment, requestForPrincipal } from "../src/payments/prepare.js";
import { normalizeAddress, parseAmountEth, validateMemo } from "@aichainpay/shared";
import type { Config } from "../src/config.js";
import type { ChainService } from "../src/blockchain/index.js";
import type Provider from "oidc-provider";
import type { JsonRpcProvider } from "ethers";

function setup() {
  const db = new Database(":memory:");
  migrate(db);
  const wallet = Wallet.createRandom();
  const agent = Wallet.createRandom();
  const recipient = Wallet.createRandom();
  const config: Config = {
    chainId: 31337, rpcUrl: "http://127.0.0.1:8545", contractAddress: Wallet.createRandom().address,
    deploymentBlock: 1, agentAddress: agent.address, databasePath: ":memory:", publicBaseUrl: "http://localhost:3000", issuer: "http://localhost:3000",
    sessionSecret: "a".repeat(48), confirmationAdapter: "disabled", requestTtlSeconds: 600, requiredConfirmations: 2, port: 3000,
  };
  const principal: Principal = { address: wallet.address, clientId: "test-client", scopes: new Set(["wallet:read", "payments:prepare", "payments:execute"]) };
  const chain = {
    check: async () => ({ chainId: 31337, codeHash: "0x", blockNumber: 1 }),
    permission: async () => ({ active: true, remainingAllowance: parseEther("1"), maxPerPayment: parseEther("0.5"), expiresAt: Math.floor(Date.now() / 1000) + 3600, epoch: 1n, restrictedRecipients: false }),
    balance: async () => parseEther("1"),
    allowed: async () => true,
  } as unknown as ChainService;
  db.prepare("INSERT INTO users(address,created_at) VALUES(?,?)").run(wallet.address, Date.now());
  return { db, wallet, recipient, agent, config, principal, chain };
}

test("strict ETH amount, address and UTF-8 memo validation", () => {
  for (const value of ["-1", "1e-3", " 1", ".1", "1.", "01", "1,000", "NaN", "0", "0.0000000000000000001"]) assert.throws(() => parseAmountEth(value));
  assert.equal(parseAmountEth("0.000000000000000001"), 1n);
  assert.throws(() => normalizeAddress("alice.eth"));
  assert.throws(() => normalizeAddress("0x123"));
  assert.throws(() => validateMemo("😀".repeat(36)));
  assert.equal(validateMemo("😀".repeat(35)), "😀".repeat(35));
});

test("SIWE challenge binds fields, consumes nonce once and rejects expiry", async () => {
  const { db, wallet, config } = setup();
  const provider = { getCode: async () => "0x" } as unknown as JsonRpcProvider;
  const challenge = createChallenge(db, config, wallet.address);
  const signature = await wallet.signMessage(challenge.message);
  const login = await verifyLogin(db, config, provider, challenge.message, signature);
  assert.equal(login.address, wallet.address);
  await assert.rejects(verifyLogin(db, config, provider, challenge.message, signature), /used|expired/);
  const another = createChallenge(db, config, wallet.address);
  const anotherSignature = await wallet.signMessage(another.message);
  await assert.rejects(verifyLogin(db, { ...config, publicBaseUrl: "http://elsewhere.test" }, provider, another.message, anotherSignature), /mismatch/);
  db.prepare("UPDATE challenges SET expires_at=0 WHERE nonce=?").run(another.nonce);
  await assert.rejects(verifyLogin(db, config, provider, another.message, anotherSignature), /expired/);
  db.close();
});

test("OAuth bearer verification rejects wrong audience, scope and expiry", async () => {
  const { db, wallet, config } = setup();
  const now = Math.floor(Date.now() / 1000);
  const make = (overrides: Record<string, unknown> = {}) => ({ accountId: wallet.address, clientId: "chat-client", exp: now + 100, aud: `${config.publicBaseUrl}/mcp`, scope: "wallet:read", ...overrides });
  const mock = (token: object | undefined) => ({ AccessToken: { find: async () => token } }) as unknown as Provider;
  assert.equal((await verifyBearer(mock(make()), config, "Bearer abc"))?.address, wallet.address);
  assert.equal(await verifyBearer(mock(make({ aud: "https://other.test/mcp" })), config, "Bearer abc"), undefined);
  assert.equal(await verifyBearer(mock(make({ scope: "payments:execute" })), config, "Bearer abc"), undefined);
  assert.equal(await verifyBearer(mock(make({ exp: now - 1 })), config, "Bearer abc"), undefined);
  assert.equal(await verifyBearer(mock(make()), config, "Basic abc"), undefined);
  db.close();
});

test("preparation is immutable, idempotent and never broadcasts", async () => {
  const { db, config, chain, principal, recipient } = setup();
  const input = { recipient: recipient.address, amount_eth: "0.1", memo: "test", client_request_id: "payment-001" };
  const first = await preparePayment(db, config, chain, principal, input);
  const second = await preparePayment(db, config, chain, principal, input);
  assert.deepEqual(first, second);
  assert.equal(first.state, "prepared");
  assert.equal(first.amount_wei, parseEther("0.1").toString());
  assert.equal(db.prepare("SELECT COUNT(*) count FROM payment_requests").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM transaction_attempts").get().count, 0);
  await assert.rejects(preparePayment(db, config, chain, principal, { ...input, amount_eth: "0.2" }), /conflicts/);
  const foreign = { ...principal, clientId: "other-client" };
  assert.equal(requestForPrincipal(db, foreign, first.request_id), undefined);
  assert.throws(() => cancelPayment(db, foreign, first.request_id), /not found/);
  assert.equal(cancelPayment(db, principal, first.request_id).state, "cancelled");
  assert.throws(() => cancelPayment(db, principal, first.request_id), /no longer cancellable/);
  db.close();
});

test("preparation rejects stale grants, insufficient balance and disallowed recipients", async () => {
  const { db, config, chain, principal, recipient } = setup();
  const input = { recipient: recipient.address, amount_eth: "0.1", client_request_id: "payment-002" };
  const inactive = { ...chain, permission: async () => ({ active: false, remainingAllowance: 1n, maxPerPayment: 1n, expiresAt: Date.now() / 1000 + 60, epoch: 1n }) } as ChainService;
  await assert.rejects(preparePayment(db, config, inactive, principal, input), /inactive/);
  const poor = { ...chain, balance: async () => 0n } as ChainService;
  await assert.rejects(preparePayment(db, config, poor, principal, input), /Insufficient/);
  const restricted = { ...chain, allowed: async () => false } as ChainService;
  await assert.rejects(preparePayment(db, config, restricted, principal, input), /not allowed/);
  const over = { ...input, amount_eth: "0.6" };
  await assert.rejects(preparePayment(db, config, chain, principal, over), /per-payment cap/);
  db.close();
});
