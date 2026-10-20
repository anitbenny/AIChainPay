import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function openDatabase(path: string): Database.Database {
  const absolute = resolve(path);
  mkdirSync(dirname(absolute), { recursive: true });
  const db = new Database(absolute);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

export function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      address TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS challenges (
      nonce TEXT PRIMARY KEY,
      address TEXT NOT NULL,
      message TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS browser_sessions (
      id_hash TEXT PRIMARY KEY,
      address TEXT NOT NULL REFERENCES users(address),
      csrf TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauth_objects (
      model TEXT NOT NULL,
      id TEXT NOT NULL,
      payload TEXT NOT NULL,
      expires_at INTEGER,
      grant_id TEXT,
      uid TEXT,
      user_code TEXT,
      PRIMARY KEY(model,id)
    );
    CREATE INDEX IF NOT EXISTS oauth_grant_idx ON oauth_objects(grant_id);
    CREATE INDEX IF NOT EXISTS oauth_uid_idx ON oauth_objects(model,uid);
    CREATE INDEX IF NOT EXISTS oauth_user_code_idx ON oauth_objects(model,user_code);
    CREATE TABLE IF NOT EXISTS payment_requests (
      id TEXT PRIMARY KEY,
      owner TEXT NOT NULL REFERENCES users(address),
      client_id TEXT NOT NULL,
      client_request_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      request_id_bytes32 TEXT NOT NULL UNIQUE,
      intent_digest TEXT NOT NULL,
      agent TEXT NOT NULL,
      chain_id INTEGER NOT NULL,
      contract_address TEXT NOT NULL,
      recipient TEXT NOT NULL,
      amount_wei TEXT NOT NULL,
      memo TEXT NOT NULL,
      permission_epoch TEXT NOT NULL,
      deadline INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('prepared','confirming','rejected','cancelled','expired','signing','signed','submitted','confirmed','reverted','reconciliation_required')),
      claim_token TEXT,
      claim_expires_at INTEGER,
      confirmation_route TEXT,
      confirmation_category TEXT,
      tx_hash TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(owner,client_id,client_request_id)
    );
    CREATE INDEX IF NOT EXISTS requests_owner_idx ON payment_requests(owner,created_at);
    CREATE TABLE IF NOT EXISTS transaction_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL REFERENCES payment_requests(id),
      nonce INTEGER NOT NULL UNIQUE,
      tx_hash TEXT NOT NULL UNIQUE,
      signed_payload TEXT NOT NULL,
      state TEXT NOT NULL,
      receipt_block_hash TEXT,
      receipt_block_number INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner TEXT,
      action TEXT NOT NULL,
      detail TEXT NOT NULL,
      at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chat_approvals (
      token_hash TEXT PRIMARY KEY,
      request_id TEXT NOT NULL REFERENCES payment_requests(id),
      owner TEXT NOT NULL,
      client_id TEXT NOT NULL,
      intent_digest TEXT NOT NULL,
      mode TEXT NOT NULL CHECK(mode IN ('verify','execute')),
      expires_at INTEGER NOT NULL,
      decision TEXT CHECK(decision IN ('approve','reject','superseded')),
      decided_at INTEGER,
      used_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS chat_approvals_request_idx ON chat_approvals(request_id);
    CREATE TABLE IF NOT EXISTS index_cursors (
      chain_id INTEGER NOT NULL,
      contract_address TEXT NOT NULL,
      next_block INTEGER NOT NULL,
      PRIMARY KEY(chain_id,contract_address)
    );
    CREATE TABLE IF NOT EXISTS payment_events (
      tx_hash TEXT NOT NULL,
      log_index INTEGER NOT NULL,
      chain_id INTEGER,
      contract_address TEXT,
      block_number INTEGER NOT NULL,
      block_hash TEXT NOT NULL,
      owner TEXT NOT NULL,
      recipient TEXT NOT NULL,
      request_id TEXT NOT NULL,
      payment_id TEXT NOT NULL,
      executor TEXT NOT NULL,
      amount_wei TEXT NOT NULL,
      memo TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      PRIMARY KEY(tx_hash,log_index)
    );
  `);
  const attemptColumns = db.pragma("table_info(transaction_attempts)") as { name: string }[];
  if (!attemptColumns.some(column => column.name === "receipt_block_hash")) db.exec("ALTER TABLE transaction_attempts ADD COLUMN receipt_block_hash TEXT");
  if (!attemptColumns.some(column => column.name === "receipt_block_number")) db.exec("ALTER TABLE transaction_attempts ADD COLUMN receipt_block_number INTEGER");
  const eventColumns = db.pragma("table_info(payment_events)") as { name: string }[];
  if (!eventColumns.some(column => column.name === "chain_id")) {
    db.exec("ALTER TABLE payment_events ADD COLUMN chain_id INTEGER");
    db.exec("UPDATE index_cursors SET next_block=0");
  }
  if (!eventColumns.some(column => column.name === "contract_address")) {
    db.exec("ALTER TABLE payment_events ADD COLUMN contract_address TEXT");
    db.exec("UPDATE index_cursors SET next_block=0");
  }
  db.exec("CREATE INDEX IF NOT EXISTS payment_events_scope_idx ON payment_events(chain_id,contract_address,block_number)");
}
