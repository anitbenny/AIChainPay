import { createHash, randomBytes } from "node:crypto";
import { JsonRpcProvider, Wallet } from "ethers";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const base = process.argv[2] ?? "http://localhost:3000";
const sepoliaReadOnly = process.argv.includes("--sepolia-read");
const chatgptRedirectOnly = process.argv.includes("--chatgpt-redirect") && !sepoliaReadOnly;
const usesChatGptClient = chatgptRedirectOnly || sepoliaReadOnly;
const clientId = usesChatGptClient ? "https://chatgpt.com/oauth/client.json" : "aichainpay-local-test";
const callback = usesChatGptClient ? "https://chatgpt.com/connector_platform_oauth_redirect" : "http://127.0.0.1:3999/callback";
const resource = `${base}/mcp`;
const cookies = new Map<string, string>();
function saveCookies(response: Response) {
  for (const cookie of response.headers.getSetCookie()) {
    const first = cookie.split(";", 1)[0];
    const cut = first.indexOf("=");
    if (cut > 0) cookies.set(first.slice(0, cut), first.slice(cut + 1));
  }
}
async function request(url: string, init: RequestInit = {}) {
  const response = await fetch(url, { ...init, redirect: "manual", headers: { "ngrok-skip-browser-warning": "1", ...(cookies.size ? { Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join("; ") } : {}), ...init.headers } });
  saveCookies(response);
  return response;
}
async function follow(url: string, max = 10): Promise<Response> {
  let next = url;
  for (let i = 0; i < max; i++) {
    const response = await request(next);
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) throw new Error("OAuth redirect has no location");
    next = new URL(location, next).href;
    if (next.startsWith(callback)) return new Response(null, { status: 302, headers: { location: next } });
  }
  throw new Error("Too many OAuth redirects");
}

async function main() {
  if (sepoliaReadOnly && new URL(base).protocol !== "https:") throw new Error("Sepolia public-read check requires HTTPS");
  const configResponse = await request(`${base}/api/config`);
  if (!configResponse.ok) throw new Error(`Public configuration unavailable: ${configResponse.status}`);
  const config = await configResponse.json() as { chainId: number; mcpUrl: string; executionEnabled: boolean };
  if (config.chainId !== (sepoliaReadOnly ? 11155111 : 31337) || config.mcpUrl !== resource || config.executionEnabled !== false) {
    throw new Error("Endpoint chain, MCP resource, or execution-disabled setting is wrong");
  }
  const healthResponse = await request(`${base}/health`);
  const health = await healthResponse.json() as { rpc: boolean; vault: boolean; execution_enabled: boolean };
  if (!healthResponse.ok || !health.rpc || !health.vault || health.execution_enabled !== false) {
    throw new Error("Endpoint is not ready with execution disabled");
  }
  const resourceResponse = await request(`${base}/.well-known/oauth-protected-resource/mcp`);
  const resourceMetadata = await resourceResponse.json() as { resource: string; authorization_servers: string[] };
  if (!resourceResponse.ok || resourceMetadata.resource !== resource ||
      resourceMetadata.authorization_servers?.length !== 1 || resourceMetadata.authorization_servers[0] !== base) {
    throw new Error("Protected-resource metadata does not match the public origin");
  }
  const issuerResponse = await request(`${base}/.well-known/oauth-authorization-server`);
  const issuerMetadata = await issuerResponse.json() as { issuer: string; authorization_endpoint: string; token_endpoint: string };
  if (!issuerResponse.ok || issuerMetadata.issuer !== base ||
      new URL(issuerMetadata.authorization_endpoint).origin !== base || new URL(issuerMetadata.token_endpoint).origin !== base) {
    throw new Error("OAuth issuer, authorization, or token endpoint does not match the public origin");
  }
  const bareMcp = await request(resource);
  if (bareMcp.status !== 401 || !bareMcp.headers.get("www-authenticate")?.includes(`${base}/.well-known/oauth-protected-resource/mcp`)) {
    throw new Error("Unauthenticated MCP must advertise the matching protected resource");
  }
  // A fresh, unfunded, memory-only test wallet signs ONLY a login message in
  // Sepolia mode. Never use an unlocked/deterministic local-chain signer there.
  const rpc = sepoliaReadOnly ? undefined : new JsonRpcProvider("http://127.0.0.1:8545");
  const signer = sepoliaReadOnly ? Wallet.createRandom() : await rpc!.getSigner(0);
  const address = await signer.getAddress();
  const verifier = randomBytes(32).toString("base64url");
  const challengeHash = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("hex");
  const auth = new URL(`${base}/auth`);
  for (const [key, value] of Object.entries({ client_id: clientId, redirect_uri: callback, response_type: "code", scope: sepoliaReadOnly ? "wallet:read" : "wallet:read payments:prepare payments:execute", resource, state, code_challenge: challengeHash, code_challenge_method: "S256" })) auth.searchParams.set(key, value);
  let response = await follow(auth.href);
  const signInPage = await response.text();
  if (!signInPage.includes("AIChainPay wallet sign-in required")) throw new Error("OAuth did not request wallet sign-in");
  const dashboardLink = /href="([^"]+)"/.exec(signInPage)?.[1];
  const dashboardUrl = dashboardLink ? new URL(dashboardLink, base) : undefined;
  const returnTo = dashboardUrl?.searchParams.get("return");
  if (!returnTo || new URL(returnTo).origin !== base || !new URL(returnTo).pathname.startsWith("/interaction/")) throw new Error("OAuth dashboard return URL is missing or points to another origin");
  const challengeResponse = await request(`${base}/api/auth/challenge`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify({ address }) });
  if (!challengeResponse.ok) throw new Error(`Challenge failed: ${challengeResponse.status}`);
  const challenge = await challengeResponse.json() as { message: string };
  const signature = await signer.signMessage(challenge.message);
  const loginResponse = await request(`${base}/api/auth/verify`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify({ message: challenge.message, signature }) });
  if (!loginResponse.ok) throw new Error(`SIWE login failed: ${loginResponse.status}`);
  const sessionCookie = loginResponse.headers.getSetCookie().find(value => value.startsWith("acp_session="));
  if (!sessionCookie || !/;\s*HttpOnly\b/i.test(sessionCookie) || !/;\s*SameSite=Lax\b/i.test(sessionCookie) || (base.startsWith("https:") && !/;\s*Secure\b/i.test(sessionCookie))) throw new Error("Wallet session cookie is missing required security attributes");
  const login = await loginResponse.json() as { csrf: string; address: string };
  response = await request(returnTo);
  const trace: string[] = [];
  for (let i = 0; i < 5; i++) {
    const location = response.headers.get("location");
    if (location?.startsWith(callback)) break;
    const current = response.url;
    if (!current.includes("/interaction/")) throw new Error(`Expected OAuth interaction, got ${response.status} at ${new URL(current).pathname}`);
    const html = await response.text();
    trace.push((/Step: ([^<]+)/.exec(html)?.[1] ?? "unknown").slice(0, 30));
    if (!html.includes("AIChainPay connection")) throw new Error("Interaction UI unavailable");
    const post = await request(current, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: base }, body: new URLSearchParams({ csrf: login.csrf, decision: "allow" }) });
    const next = post.headers.get("location");
    if (!next) throw new Error(`Interaction not completed: ${post.status}`);
    response = await follow(new URL(next, current).href);
  }
  const callbackUrl = response.headers.get("location");
  if (!callbackUrl?.startsWith(callback)) throw new Error(`Authorization code not delivered; status=${response.status}, path=${new URL(response.url).pathname}, redirect_path=${callbackUrl ? new URL(callbackUrl, response.url).pathname : "none"}, prompts=${trace.join(",")}`);
  const parsed = new URL(callbackUrl);
  if (parsed.searchParams.get("state") !== state) throw new Error("OAuth state mismatch");
  if (usesChatGptClient && parsed.searchParams.get("iss") !== base) throw new Error("Callback issuer mismatch");
  const code = parsed.searchParams.get("code");
  if (!code) throw new Error(`Authorization failed: ${parsed.searchParams.get("error") ?? "missing code"}`);
  if (chatgptRedirectOnly) {
    if (parsed.searchParams.get("iss") !== base) throw new Error("ChatGPT callback issuer parameter missing or mismatched");
    console.log(JSON.stringify({ chatgpt_client_metadata: clientId, callback_origin: parsed.origin, callback_path: parsed.pathname, issuer_parameter_matches: true, authorization_code_issued: true, token_exchange_by_chatgpt: "not tested", execution_disabled: true }, null, 2));
    return;
  }
  if (sepoliaReadOnly) {
    const metadataResponse = await fetch(clientId);
    if (!metadataResponse.ok) throw new Error("ChatGPT public client metadata unavailable");
    const metadata = await metadataResponse.json() as { token_endpoint_auth_method?: string };
    if (metadata.token_endpoint_auth_method === "private_key_jwt") {
      // Only ChatGPT owns its client assertion signing key. Never weaken client
      // authentication or claim this synthetic callback as a real ChatGPT read.
      console.log(JSON.stringify({ test: "synthetic Sepolia login and OAuth callback only",
        chain_id: 11155111, public_resource: resource, callback_origin: parsed.origin,
        callback_path: parsed.pathname, issuer_matches: true, secure_cookie_checked: true,
        bare_mcp_status: 401, authorization_code_issued: true,
        client_authentication: "private_key_jwt",
        token_exchange: "requires real ChatGPT signed client assertion; not tested",
        authenticated_mcp_read: "not tested", execution_disabled: true,
        payment_tools_called: 0, blockchain_transactions: 0 }, null, 2));
      return;
    }
  }
  const tokenResponse = await request(`${base}/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, redirect_uri: callback, code, code_verifier: verifier, resource }) });
  if (!tokenResponse.ok) throw new Error(`Token exchange failed: ${tokenResponse.status}`);
  const token = await tokenResponse.json() as { access_token: string };
  const client = new Client({ name: sepoliaReadOnly ? "aichainpay-sepolia-synthetic-read" : "aichainpay-local-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(resource), { requestInit: { headers: { Authorization: `Bearer ${token.access_token}`, "ngrok-skip-browser-warning": "1" } } });
  await client.connect(transport);
  const tools = await client.listTools();
  const balance = await client.callTool({ name: "get_contract_balance", arguments: {} });
  if (sepoliaReadOnly) {
    const network = await client.callTool({ name: "get_supported_network", arguments: {} });
    const owner = await client.callTool({ name: "get_wallet_address", arguments: {} });
    const balanceData = (balance.structuredContent as { result?: { owner: string; vault_balance_wei: string } })?.result;
    const networkData = (network.structuredContent as { result?: { chain_id: number } })?.result;
    const ownerData = (owner.structuredContent as { result?: { address: string } })?.result;
    if (balance.isError || network.isError || owner.isError || networkData?.chain_id !== 11155111 ||
        ownerData?.address !== address || balanceData?.owner !== address || balanceData?.vault_balance_wei !== "0") {
      throw new Error("Synthetic Sepolia authenticated read returned incorrect identity/network/balance");
    }
    console.log(JSON.stringify({ test: "synthetic OAuth/PKCE + authenticated MCP reads, NOT real ChatGPT account evidence",
      chain_id: 11155111, synthetic_wallet: address, public_resource: resource,
      callback_origin: parsed.origin, callback_path: parsed.pathname, issuer_matches: true,
      secure_cookie_checked: true, bare_mcp_status: 401, oauth: "authorization_code_pkce_passed",
      mcp_initialized: true, tool_count: tools.tools.length, vault_balance_wei: balanceData.vault_balance_wei,
      execution_disabled: true, payment_tools_called: 0, blockchain_transactions: 0 }, null, 2));
    await client.close();
    return;
  }
  const history = await client.callTool({ name: "get_recent_transactions", arguments: { limit: 5 } });
  const disabled = await client.callTool({ name: "execute_payment", arguments: { request_id: "00000000-0000-4000-8000-000000000001", intent_digest: `0x${"0".repeat(64)}` } });
  if (balance.isError || history.isError || !disabled.isError) throw new Error("MCP tool behavior incorrect");
  const indexed = (history.structuredContent as { result?: { items: unknown[]; indexing_complete_through_latest_block: boolean } } | undefined)?.result;
  if (!indexed?.indexing_complete_through_latest_block) throw new Error("Local event indexer did not reach latest block");
  console.log(JSON.stringify({ local_chain: 31337, wallet: login.address, oauth: "authorization_code_pkce_passed", mcp_initialized: true, tools: tools.tools.map(x => x.name), balance_result: balance.structuredContent, indexed_vault_payments: indexed.items.length, execution_disabled: true }, null, 2));
  await client.close();
}

main().catch(error => { console.error(error instanceof Error ? error.message : "Local MCP test failed"); process.exitCode = 1; });
