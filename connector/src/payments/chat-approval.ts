import { createHash, randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import type { Principal } from "../auth/oauth.js";
import type { ConfirmationAdapter } from "./execute.js";
import { preview, requestForPrincipal } from "./prepare.js";

const now = () => Math.floor(Date.now() / 1000);
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
function requireChat(principal: Principal) {
  if (!principal.scopes.has("payments:execute") || !/^https:\/\/chatgpt\.com\/oauth\/(?:client\.json|[^/]+\/client\.json)$/.test(principal.clientId)) {
    throw new Error("Chat confirmation requires the authenticated ChatGPT payment client");
  }
}
function currentRequest(db: Database.Database, principal: Principal, id: string, digest: string) {
  requireChat(principal);
  const row = requestForPrincipal(db, principal, id);
  if (!row || row.intent_digest !== digest) throw new Error("Payment owner, client or digest mismatch");
  if (row.state !== "prepared" || row.deadline <= now()) throw new Error("Payment is not prepared or has expired; prepare a new intent");
  return row;
}

/** The token goes ONLY in widget-private tool-result _meta, never model content. */
export function issueChatApproval(db: Database.Database, config: Config, principal: Principal, id: string, digest: string) {
  const row = currentRequest(db, principal, id, digest);
  const token = randomBytes(32).toString("hex");
  const mode = config.confirmationAdapter === "chatgpt_app" ? "execute" : "verify";
  db.transaction(() => {
    db.prepare("UPDATE chat_approvals SET decision='superseded',used_at=? WHERE request_id=? AND used_at IS NULL").run(now(), id);
    db.prepare("INSERT INTO chat_approvals(token_hash,request_id,owner,client_id,intent_digest,mode,expires_at) VALUES(?,?,?,?,?,?,?)")
      .run(hash(token), id, principal.address, principal.clientId, digest, mode, row.deadline);
  })();
  return { payment: preview(row), mode, token };
}

type Approval = { request_id: string; owner: string; client_id: string; intent_digest: string; mode: string; expires_at: number; decision: string | null; used_at: number | null };

/** Not proof against a malicious host: trusts host isolation of _meta/app-only tools. */
export function decideChatApproval(db: Database.Database, config: Config, principal: Principal,
  input: { request_id: string; intent_digest: string; token: string; decision: "approve" | "reject" }) {
  return db.transaction(() => {
    const row = currentRequest(db, principal, input.request_id, input.intent_digest);
    if (!/^[a-f0-9]{64}$/.test(input.token)) throw new Error("Invalid confirmation capability");
    const approval = db.prepare("SELECT * FROM chat_approvals WHERE token_hash=?").get(hash(input.token)) as Approval | undefined;
    const mode = config.confirmationAdapter === "chatgpt_app" ? "execute" : "verify";
    if (!approval || approval.owner !== principal.address || approval.client_id !== principal.clientId ||
      approval.request_id !== row.id || approval.intent_digest !== row.intent_digest || approval.expires_at <= now() ||
      approval.decision !== null || approval.used_at !== null || approval.mode !== mode) throw new Error("Confirmation capability expired, used, mode-changed or mismatched");
    const changed = db.prepare("UPDATE chat_approvals SET decision=?,decided_at=? WHERE token_hash=? AND decision IS NULL AND used_at IS NULL")
      .run(input.decision, now(), hash(input.token));
    if (changed.changes !== 1) throw new Error("Confirmation already used");
    if (input.decision === "reject") {
      db.prepare("UPDATE payment_requests SET state='rejected',confirmation_route='mcp_app_card',confirmation_category='declined',updated_at=? WHERE id=? AND state='prepared'").run(now(), row.id);
    }
    if (mode === "verify" || input.decision === "reject") {
      db.prepare("UPDATE chat_approvals SET used_at=? WHERE token_hash=?").run(now(), hash(input.token));
    }
    db.prepare("INSERT INTO audit_entries(owner,action,detail,at) VALUES(?,?,?,?)")
      .run(principal.address, "chat_card_decision", JSON.stringify({ request_id: row.id, intent_digest: row.intent_digest, decision: input.decision, mode }), now());
    return { mode, decision: input.decision, request_id: row.id };
  })();
}

export function chatAppConfirmation(db: Database.Database, config: Config): ConfirmationAdapter {
  return async (row, principal) => {
    requireChat(principal);
    if (config.confirmationAdapter !== "chatgpt_app" || row.deadline <= now()) return { category: "unsupported", route: "mcp_app_disabled_or_expired" };
    const used = db.prepare("UPDATE chat_approvals SET used_at=? WHERE request_id=? AND owner=? AND client_id=? AND intent_digest=? AND mode='execute' AND decision='approve' AND used_at IS NULL AND expires_at>?")
      .run(now(), row.id, principal.address, principal.clientId, row.intent_digest, now());
    return used.changes === 1 ? { category: "accepted", route: "mcp_app_one_use_capability_host_trusted" } : { category: "unsupported", route: "mcp_app_missing_fresh_approval" };
  };
}
