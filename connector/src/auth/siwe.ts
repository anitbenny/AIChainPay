import { createHash, randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import type { JsonRpcProvider } from "ethers";
import { SiweMessage } from "siwe";
import { normalizeAddress } from "@aichainpay/shared";
import type { Config } from "../config.js";

export type BrowserSession = { address: string; csrf: string; expires_at: number };

export function hashSession(value: string): string { return createHash("sha256").update(value).digest("hex"); }

// EIP-7702 EOAs have a 23-byte delegation indicator, not empty account code.
// The SIWE signature above must still recover the account's own EOA key.
export function isEoaAccountCode(code: string): boolean {
  return code === "0x" || /^0xef0100[0-9a-f]{40}$/i.test(code);
}

export function createChallenge(db: Database.Database, config: Config, addressInput: string) {
  const address = normalizeAddress(addressInput);
  const nonce = randomBytes(16).toString("hex");
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + 5 * 60_000);
  const message = new SiweMessage({
    domain: new URL(config.publicBaseUrl).host,
    address,
    statement: config.chainId === 31337
      ? "Sign in to the AIChainPay local test-chain connector. This does not grant spending permission."
      : "Sign in to manage your AIChainPay Sepolia vault. This does not grant spending permission.",
    uri: config.publicBaseUrl,
    version: "1",
    chainId: config.chainId,
    nonce,
    issuedAt: issuedAt.toISOString(),
    expirationTime: expiresAt.toISOString(),
  }).prepareMessage();
  db.prepare("INSERT INTO challenges(nonce,address,message,expires_at) VALUES(?,?,?,?)").run(nonce, address, message, Math.floor(expiresAt.getTime() / 1000));
  return { message, nonce, expiresAt: expiresAt.toISOString() };
}

export async function verifyLogin(db: Database.Database, config: Config, provider: JsonRpcProvider, message: string, signature: string, oldCookie?: string) {
  const parsed = new SiweMessage(message);
  const row = db.prepare("SELECT address,message,expires_at,consumed_at FROM challenges WHERE nonce=?").get(parsed.nonce) as { address: string; message: string; expires_at: number; consumed_at: number | null } | undefined;
  const now = Math.floor(Date.now() / 1000);
  if (!row || row.consumed_at || row.expires_at <= now || row.message !== message) throw new Error("Challenge missing, changed, used or expired");
  if (parsed.domain !== new URL(config.publicBaseUrl).host || parsed.uri !== config.publicBaseUrl || parsed.chainId !== config.chainId || parsed.version !== "1" || normalizeAddress(parsed.address) !== row.address) throw new Error("SIWE message fields mismatch");
  if (!parsed.issuedAt || !parsed.expirationTime || new Date(parsed.issuedAt).getTime() > Date.now() + 30_000 || new Date(parsed.expirationTime).getTime() <= Date.now()) throw new Error("SIWE time bounds invalid");
  const result = await parsed.verify({ signature, domain: parsed.domain, nonce: parsed.nonce, time: new Date().toISOString() });
  if (!result.success) throw new Error("Invalid SIWE signature");
  if (!isEoaAccountCode(await provider.getCode(row.address))) throw new Error("Only EOA wallets are supported in v1");
  const cookie = randomBytes(32).toString("base64url");
  const csrf = randomBytes(24).toString("base64url");
  const expires = now + 12 * 3600;
  db.transaction(() => {
    const claimed = db.prepare("UPDATE challenges SET consumed_at=? WHERE nonce=? AND consumed_at IS NULL AND expires_at>?").run(now, parsed.nonce, now);
    if (claimed.changes !== 1) throw new Error("Challenge already consumed");
    db.prepare("INSERT OR IGNORE INTO users(address,created_at) VALUES(?,?)").run(row.address, now);
    if (oldCookie) db.prepare("DELETE FROM browser_sessions WHERE id_hash=?").run(hashSession(oldCookie));
    db.prepare("INSERT INTO browser_sessions(id_hash,address,csrf,expires_at) VALUES(?,?,?,?)").run(hashSession(cookie), row.address, csrf, expires);
    db.prepare("INSERT INTO audit_entries(owner,action,detail,at) VALUES(?,?,?,?)").run(row.address, "siwe_login", "EOA signature verified", now);
  })();
  return { cookie, address: row.address, csrf, expiresAt: expires };
}

export function getBrowserSession(db: Database.Database, cookie?: string): BrowserSession | undefined {
  if (!cookie) return undefined;
  const row = db.prepare("SELECT address,csrf,expires_at FROM browser_sessions WHERE id_hash=?").get(hashSession(cookie)) as BrowserSession | undefined;
  if (!row || row.expires_at <= Math.floor(Date.now() / 1000)) return undefined;
  return row;
}
