import "dotenv/config";
import express, { type Request, type Response, type NextFunction } from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatEther } from "ethers";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db/index.js";
import { ChainService } from "./blockchain/index.js";
import { PaymentIndexer } from "./blockchain/indexer.js";
import { createChallenge, getBrowserSession, hashSession, verifyLogin } from "./auth/siwe.js";
import { createOAuthProvider, verifyBearer } from "./auth/oauth.js";
import { createMcpServer } from "./mcp/server.js";
import { ExecutionService, chatGptNativeConfirmation } from "./payments/execute.js";
import { chatAppConfirmation } from "./payments/chat-approval.js";
import { preview, type PaymentRequestRow } from "./payments/prepare.js";

async function main() {
  const config = loadConfig();
  const db = openDatabase(config.databasePath);
  const chain = new ChainService(config);
  const indexer = new PaymentIndexer(db, config, chain);
  const execution = new ExecutionService(db, config, chain, config.confirmationAdapter === "chatgpt_app" ? chatAppConfirmation(db, config) : chatGptNativeConfirmation(config));
  const oauth = createOAuthProvider(db, config);
  const isSecure = config.publicBaseUrl.startsWith("https:");
  const app = createMcpExpressApp({ host: new URL(config.publicBaseUrl).hostname });
  app.disable("x-powered-by");
  // Keep OAuth diagnostics useful without recording codes, state, cookies, or interaction IDs.
  app.use((req, res, next) => {
    const redactPath = (path: string) => path.replace(/^\/interaction\/[^/]+/, "/interaction/:uid").replace(/^\/auth\/[^/]+/, "/auth/:id");
    const path = redactPath(req.path);
    if (!/^\/(?:auth|token|interaction|mcp|api\/auth|\.well-known)(?:\/|$)/.test(path)) { next(); return; }
    res.on("finish", () => {
      const location = res.getHeader("Location");
      let redirect: string | undefined;
      if (typeof location === "string") {
        try {
          const target = new URL(location, config.publicBaseUrl);
          redirect = `${target.origin}${redactPath(target.pathname)}`;
        } catch { /* Invalid redirect is still visible through the status. */ }
      }
      console.log(JSON.stringify({ at: new Date().toISOString(), method: req.method, path, status: res.statusCode, redirect }));
    });
    next();
  });
  app.use(["/api", "/mcp"], express.json({ limit: "32kb" }));
  app.use("/interaction", express.urlencoded({ extended: false, limit: "16kb" }));

  function cookie(req: Request): string | undefined {
    const raw = req.headers.cookie?.split(";").map(x => x.trim()).find(x => x.startsWith("acp_session="));
    return raw?.slice("acp_session=".length);
  }
  function session(req: Request) { return getBrowserSession(db, cookie(req)); }
  function originGuard(req: Request, res: Response, next: NextFunction) {
    const allowed = [config.publicBaseUrl, process.env.DEV_FRONTEND_ORIGIN].filter(Boolean);
    if (req.headers.origin && !allowed.includes(req.headers.origin)) { res.status(403).json({ error: "Origin not allowed" }); return; }
    next();
  }
  function csrfGuard(req: Request, res: Response, next: NextFunction) {
    const current = session(req);
    if (!current || req.get("X-CSRF-Token") !== current.csrf) { res.status(403).json({ error: "Session or CSRF token invalid" }); return; }
    next();
  }
  function escapeHtml(value: string) { return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char]!); }

  app.get("/health", async (_req, res) => {
    try { await chain.check(); res.json({ server: true, rpc: true, vault: true, execution_enabled: config.confirmationAdapter !== "disabled" }); }
    catch { res.status(503).json({ server: true, rpc: false, vault: false, execution_enabled: false }); }
  });
  app.get("/api/config", (_req, res) => res.json({ chainId: config.chainId, contractAddress: config.contractAddress, agentAddress: config.agentAddress ?? null, mcpUrl: `${config.publicBaseUrl}/mcp`, explorerUrl: config.chainId === 11155111 ? "https://sepolia.etherscan.io" : null, executionEnabled: config.confirmationAdapter !== "disabled" }));
  app.post("/api/auth/challenge", originGuard, (req, res) => {
    try { res.json(createChallenge(db, config, req.body.address)); }
    catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Invalid request" }); }
  });
  app.post("/api/auth/verify", originGuard, async (req, res) => {
    try {
      const result = await verifyLogin(db, config, chain.provider, req.body.message, req.body.signature, cookie(req));
      res.cookie("acp_session", result.cookie, { httpOnly: true, secure: isSecure, sameSite: "lax", path: "/", maxAge: 12 * 3600_000 });
      res.json({ address: result.address, csrf: result.csrf });
    } catch (error) { res.status(401).json({ error: error instanceof Error ? error.message : "Login failed" }); }
  });
  app.get("/api/auth/me", (req, res) => { const current = session(req); res.json(current ? { address: current.address, csrf: current.csrf } : { address: null }); });
  app.post("/api/auth/logout", originGuard, csrfGuard, (req, res) => {
    db.prepare("DELETE FROM browser_sessions WHERE id_hash=?").run(hashSession(cookie(req)!));
    res.clearCookie("acp_session", { path: "/", secure: isSecure, sameSite: "lax" });
    res.json({ disconnected: true, onChainPermissionRevoked: false });
  });
  app.get("/api/dashboard", async (req, res) => {
    const current = session(req);
    if (!current) { res.status(401).json({ error: "Wallet login required" }); return; }
    try {
      await chain.check();
      const [wallet, vault, agentGas, grant] = await Promise.all([
        chain.provider.getBalance(current.address), chain.balance(current.address), config.agentAddress ? chain.provider.getBalance(config.agentAddress) : Promise.resolve(0n),
        config.agentAddress ? chain.permission(current.address, config.agentAddress) : Promise.resolve(null),
      ]);
      const activity = db.prepare("SELECT action,detail,at FROM audit_entries WHERE owner=? ORDER BY at DESC LIMIT 10").all(current.address);
      const mcpRequestObserved = Boolean(db.prepare("SELECT 1 FROM audit_entries WHERE owner=? AND action='mcp_request' LIMIT 1").get(current.address));
      res.json({ address: current.address, walletEth: formatEther(wallet), vaultEth: formatEther(vault), agentGasEth: config.agentAddress ? formatEther(agentGas) : null,
        permission: grant ? { active: grant.active, remainingAllowanceEth: formatEther(grant.remainingAllowance), maxPerPaymentEth: formatEther(grant.maxPerPayment), expiresAt: grant.expiresAt, epoch: grant.epoch.toString(), restrictedRecipients: grant.restrictedRecipients } : null,
        verifiedConnectorActivity: activity, mcpRequestObserved });
    } catch { res.status(503).json({ error: "Chain data unavailable or configured vault invalid" }); }
  });
  app.get("/api/payments", async (req, res) => {
    const current = session(req);
    if (!current) { res.status(401).json({ error: "Wallet login required" }); return; }
    try {
      const progress = await indexer.sync();
      const history = indexer.recentFor(current.address, 0, 20);
      res.json({ ...history, indexing: progress, scope: "AIChainPay vault events only" });
    } catch { res.status(503).json({ error: "Payment event indexing unavailable" }); }
  });
  app.get("/api/requests", (req, res) => {
    const current = session(req);
    if (!current) { res.status(401).json({ error: "Wallet login required" }); return; }
    const now = Math.floor(Date.now() / 1000);
    db.prepare("UPDATE payment_requests SET state='expired',updated_at=? WHERE owner=? AND state='prepared' AND tx_hash IS NULL AND deadline<=?").run(now, current.address, now);
    const rows = db.prepare("SELECT * FROM payment_requests WHERE owner=? ORDER BY created_at DESC LIMIT 20").all(current.address) as PaymentRequestRow[];
    res.json({ items: rows.map(row => preview(row)), scope: "Prepared requests for this verified wallet; on-chain confirmation must be checked separately" });
  });

  const resource = `${config.publicBaseUrl}/mcp`;
  app.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"], (_req, res) => res.json({ resource, authorization_servers: [config.issuer], scopes_supported: ["wallet:read", "payments:prepare", "payments:execute"], bearer_methods_supported: ["header"] }));
  app.all("/mcp", async (req, res) => {
    const principal = await verifyBearer(oauth, config, req.get("Authorization"));
    if (!principal) {
      res.set("WWW-Authenticate", `Bearer resource_metadata="${config.publicBaseUrl}/.well-known/oauth-protected-resource/mcp"`);
      res.status(401).json({ error: "OAuth bearer token required" });
      return;
    }
    db.prepare("INSERT INTO audit_entries(owner,action,detail,at) VALUES(?,?,?,?)").run(principal.address, "mcp_request", principal.clientId.slice(0, 200), Math.floor(Date.now() / 1000));
    if (req.body?.method === "tools/call") {
      const requestedName = req.body?.params?.name;
      const toolName = typeof requestedName === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(requestedName) ? requestedName : "unknown";
      res.on("finish", () => {
        try {
          db.prepare("INSERT INTO audit_entries(owner,action,detail,at) VALUES(?,?,?,?)").run(
            principal.address, "mcp_tool_call", `${toolName} status=${res.statusCode} client=${principal.clientId.slice(0, 120)}`, Math.floor(Date.now() / 1000),
          );
        } catch { console.error("MCP tool audit write failed"); }
      });
    }
    const mcp = createMcpServer(db, config, chain, indexer, principal, execution);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try { await mcp.connect(transport); await transport.handleRequest(req, res, req.body); }
    catch { if (!res.headersSent) res.status(500).json({ error: "MCP transport failed" }); }
    finally { await mcp.close(); }
  });

  app.get("/interaction/:uid", async (req, res) => {
    try {
      const details = await oauth.interactionDetails(req, res);
      const current = session(req);
      if (!current) {
        const returnTo = encodeURIComponent(`${config.publicBaseUrl}/interaction/${encodeURIComponent(req.params.uid)}`);
        res.type("html").send(`<html><body><h1>AIChainPay wallet sign-in required</h1><p>Sign in with MetaMask on the dashboard, then return here.</p><a href="/?return=${returnTo}">Open dashboard</a></body></html>`);
        return;
      }
      const requested = String(details.params.scope ?? "");
      const client = escapeHtml(details.params.client_id?.toString() ?? "unknown client");
      const prompt = escapeHtml(details.prompt.name);
      res.set("Cache-Control", "no-store").type("html").send(`<!doctype html><html><body><h1>AIChainPay connection</h1><p>Verified wallet: ${escapeHtml(current.address)}</p><p>Client: ${client}</p><p>Step: ${prompt}</p><p>Requested scopes: ${escapeHtml(requested)}</p><p>OAuth access does not grant or revoke on-chain spending. That requires a separate MetaMask transaction.</p><form method="post"><input type="hidden" name="csrf" value="${escapeHtml(current.csrf)}"><button type="submit" name="decision" value="allow">Continue</button><button type="submit" name="decision" value="deny">Deny</button></form></body></html>`);
    } catch { res.status(400).send("Invalid or expired authorization interaction"); }
  });
  app.post("/interaction/:uid", originGuard, async (req, res) => {
    try {
      const details = await oauth.interactionDetails(req, res);
      const current = session(req);
      if (!current || req.body.csrf !== current.csrf) { res.status(403).send("Wallet session or CSRF token invalid"); return; }
      if (req.body.decision !== "allow") { await oauth.interactionFinished(req, res, { error: "access_denied" }); return; }
      if (details.prompt.name === "login") {
        await oauth.interactionFinished(req, res, { login: { accountId: current.address } });
      } else if (details.prompt.name === "consent") {
        const resourceRequested = String(details.params.resource ?? resource);
        if (resourceRequested !== resource) { res.status(400).send("Unknown resource"); return; }
        const requested = String(details.params.scope ?? "").split(" ").filter(x => ["wallet:read", "payments:prepare", "payments:execute"].includes(x));
        const grant = new oauth.Grant({ accountId: current.address, clientId: String(details.params.client_id) });
        const missingOidcScope = (details.prompt.details as { missingOIDCScope?: string }).missingOIDCScope;
        if (missingOidcScope) grant.addOIDCScope(missingOidcScope);
        grant.addResourceScope(resource, requested.join(" "));
        const grantId = await grant.save();
        await oauth.interactionFinished(req, res, { consent: { grantId } });
      } else { res.status(400).send("Unsupported interaction"); }
    } catch { if (!res.headersSent) res.status(400).send("Authorization interaction failed"); }
  });

  const frontendDist = fileURLToPath(new URL("../../frontend/dist/", import.meta.url));
  if (existsSync(frontendDist)) {
    app.use(express.static(frontendDist));
    app.get("/", (_req, res) => res.sendFile(resolve(frontendDist, "index.html")));
  }
  app.use(oauth.callback());
  await chain.check();
  if (config.confirmationAdapter !== "disabled") await execution.recover();
  const listenHost = process.env.LISTEN_HOST || "0.0.0.0";
  app.listen(config.port, listenHost, () => console.log(`AIChainPay connector listening on ${listenHost}:${config.port}; execution ${config.confirmationAdapter === "disabled" ? "disabled" : "enabled"}`));
}

main().catch(error => { console.error(error instanceof Error ? error.message : "Startup failed"); process.exitCode = 1; });
