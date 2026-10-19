import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v3";
import type Database from "better-sqlite3";
import { formatEther } from "ethers";
import { EXPLORER_BASE_URL } from "@aichainpay/shared";
import type { Config } from "../config.js";
import type { Principal } from "../auth/oauth.js";
import type { ChainService } from "../blockchain/index.js";
import type { PaymentIndexer } from "../blockchain/indexer.js";
import { cancelPayment, preparePayment, preview, requestForPrincipal } from "../payments/prepare.js";
import type { ExecutionService } from "../payments/execute.js";

const resultSchema = z.object({ result: z.unknown() });
function ok(result: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: { result } }; }
function fail(error: unknown) { return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : "Request failed" }], isError: true }; }
const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const write = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const;
function requireScope(principal: Principal, scope: string) { if (!principal.scopes.has(scope)) throw new Error(`Missing ${scope} scope`); }

export function createMcpServer(db: Database.Database, config: Config, chain: ChainService, indexer: PaymentIndexer, principal: Principal, execution: ExecutionService): McpServer {
  const server = new McpServer({ name: "AIChainPay", version: "0.1.0" }, {
    instructions: `All payments spend deposited AIChainPay vault ETH on Sepolia, not ordinary MetaMask wallet ETH. Execute only after reviewing the stored intent. Execution is ${config.confirmationAdapter === "disabled" ? "disabled until a real in-chat approval adapter has been verified" : "gated by the tested ChatGPT native write approval"}.`,
  });
  // The SDK's generic Zod v3/v4 overload becomes prohibitively expensive under
  // strict TS for this many tools. Runtime schemas remain registered and checked.
  const registerTool = server.registerTool.bind(server) as unknown as (name: string, config: Record<string, unknown>, callback: (args: any) => Promise<unknown>) => void;

  registerTool("get_wallet_address", { description: "Get the EOA verified by wallet sign-in for this OAuth connection.", inputSchema: z.object({}).strict(), outputSchema: resultSchema, annotations: readOnly }, async () => ok({ address: principal.address, chain_id: config.chainId }));
  registerTool("get_supported_network", { description: "Get the configured test network. Production supports Sepolia only.", inputSchema: z.object({}).strict(), outputSchema: resultSchema, annotations: readOnly }, async () => ok({ chain_id: config.chainId, name: config.chainId === 11155111 ? "Sepolia" : "Explicit local test chain", explorer_url: config.chainId === 11155111 ? EXPLORER_BASE_URL : null }));

  registerTool("get_native_balance", { description: "Read this verified owner's ordinary wallet ETH balance, not vault credit.", inputSchema: z.object({}).strict(), outputSchema: resultSchema, annotations: readOnly }, async () => {
    try { requireScope(principal, "wallet:read"); await chain.check(); const wei = await chain.provider.getBalance(principal.address); return ok({ wallet: principal.address, balance_wei: wei.toString(), balance_eth: formatEther(wei) }); } catch (error) { return fail(error); }
  });
  registerTool("get_contract_balance", { description: "Read this verified owner's spendable deposited AIChainPay vault ETH.", inputSchema: z.object({}).strict(), outputSchema: resultSchema, annotations: readOnly }, async () => {
    try { requireScope(principal, "wallet:read"); await chain.check(); const wei = await chain.balance(principal.address); return ok({ owner: principal.address, vault_balance_wei: wei.toString(), vault_balance_eth: formatEther(wei) }); } catch (error) { return fail(error); }
  });
  registerTool("get_agent_permission", { description: "Read this verified owner's dedicated agent grant and limits.", inputSchema: z.object({}).strict(), outputSchema: resultSchema, annotations: readOnly }, async () => {
    try { requireScope(principal, "wallet:read"); if (!config.agentAddress) throw new Error("Agent address not configured"); await chain.check(); const p = await chain.permission(principal.address, config.agentAddress); return ok({ agent: config.agentAddress, active: p.active, remaining_allowance_wei: p.remainingAllowance.toString(), max_per_payment_wei: p.maxPerPayment.toString(), expires_at: new Date(p.expiresAt * 1000).toISOString(), epoch: p.epoch.toString(), restricted_recipients: p.restrictedRecipients }); } catch (error) { return fail(error); }
  });
  registerTool("probe_write_confirmation", { description: "Harmless confirmation feasibility probe. Writes only a local audit entry; does not sign or broadcast a transaction. Use to observe whether this chat client requests human approval for write tools.", inputSchema: z.object({}).strict(), outputSchema: resultSchema, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }, async () => {
    try {
      requireScope(principal, "wallet:read");
      const at = Math.floor(Date.now() / 1000);
      const event = db.prepare("INSERT INTO audit_entries(owner,action,detail,at) VALUES(?,?,?,?)").run(principal.address, "confirmation_probe", principal.clientId.slice(0, 200), at);
      return ok({ probe_id: Number(event.lastInsertRowid), audited_at: new Date(at * 1000).toISOString(), blockchain_transaction: false, approval_ui_observed_by_server: false });
    } catch (error) { return fail(error); }
  });

  registerTool("prepare_payment", {
    description: "Create an immutable off-chain preview of an ETH transfer from this verified owner's AIChainPay vault. This does not broadcast a transaction.",
    inputSchema: z.object({ recipient: z.string().max(42), amount_eth: z.string().max(80), memo: z.string().max(140).optional(), client_request_id: z.string().max(100) }).strict(),
    outputSchema: resultSchema, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async (args) => { try { return ok(await preparePayment(db, config, chain, principal, args)); } catch (error) { return fail(error); } });

  registerTool("execute_payment", {
    description: "Execute a stored immutable vault payment only after supported in-chat confirmation. Currently disabled: no transaction is broadcast.",
    inputSchema: z.object({ request_id: z.string().uuid(), intent_digest: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }).strict(), outputSchema: resultSchema, annotations: write,
  }, async ({ request_id, intent_digest }) => {
    try {
      requireScope(principal, "payments:execute");
      const row = requestForPrincipal(db, principal, request_id);
      if (!row) throw new Error("Request not found for this authenticated wallet and client");
      if (row.intent_digest !== intent_digest) throw new Error("Intent digest mismatch");
      if (config.confirmationAdapter === "disabled") return fail(new Error("Execution disabled: no verified in-chat human-confirmation adapter. No transaction was signed or broadcast."));
      return ok(await execution.execute(principal, request_id, intent_digest));
    } catch (error) { return fail(error); }
  });

  registerTool("cancel_payment_request", { description: "Cancel this authenticated client's own prepared request. No blockchain transaction is sent.", inputSchema: z.object({ request_id: z.string().uuid() }).strict(), outputSchema: resultSchema, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }, async ({ request_id }) => {
    try { requireScope(principal, "payments:prepare"); return ok(cancelPayment(db, principal, request_id)); } catch (error) { return fail(error); }
  });
  registerTool("get_request_status", { description: "Read actual persisted status for this authenticated client's own request; this does not imply on-chain confirmation.", inputSchema: z.object({ request_id: z.string().uuid() }).strict(), outputSchema: resultSchema, annotations: readOnly }, async ({ request_id }) => {
    try { const row = requestForPrincipal(db, principal, request_id); if (!row) throw new Error("Request not found"); return ok(await execution.status(principal, request_id)); } catch (error) { return fail(error); }
  });
  registerTool("get_transaction", { description: "Read an actual transaction and receipt from the configured chain; pending, reverted and not-found are distinct.", inputSchema: z.object({ transaction_hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }).strict(), outputSchema: resultSchema, annotations: readOnly }, async ({ transaction_hash }) => {
    try {
      requireScope(principal, "wallet:read"); await chain.check();
      const tx = await chain.provider.getTransaction(transaction_hash);
      if (!tx) return ok({ status: "not_found", transaction_hash });
      const receipt = await chain.provider.getTransactionReceipt(transaction_hash);
      const currentBlock = await chain.provider.getBlockNumber();
      return ok({ status: !receipt ? "pending" : receipt.status === 1 ? "mined_success" : "reverted", transaction_hash, from: tx.from, to: tx.to, value_wei: tx.value.toString(), block_number: receipt?.blockNumber ?? null, confirmations: receipt ? currentBlock - receipt.blockNumber + 1 : 0, explorer_url: config.chainId === 11155111 ? `${EXPLORER_BASE_URL}/tx/${transaction_hash}` : null });
    } catch (error) { return fail(error); }
  });
  registerTool("get_recent_transactions", { description: "Read this owner's recorded vault payments. This is not full wallet history.", inputSchema: z.object({ cursor: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(20).optional() }).strict(), outputSchema: resultSchema, annotations: readOnly }, async ({ cursor = 0, limit = 10 }) => {
    try {
      requireScope(principal, "wallet:read"); await chain.check();
      const progress = await indexer.sync();
      const history = indexer.recentFor(principal.address, cursor, limit);
      return ok({ scope: "AIChainPay vault payments involving this owner; not full wallet history", items: history.items, next_cursor: history.nextCursor,
        indexing_complete_through_latest_block: progress.complete, indexed_through_block: progress.indexedThrough, latest_block: progress.latestBlock });
    } catch (error) { return fail(error); }
  });
  return server;
}
