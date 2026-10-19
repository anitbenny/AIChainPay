import { createHash, randomBytes } from "node:crypto";
import { JsonRpcProvider } from "ethers";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const base = "http://localhost:3000";
const callback = "http://127.0.0.1:3999/callback";
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
  const response = await fetch(url, { ...init, redirect: "manual", headers: { ...(cookies.size ? { Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join("; ") } : {}), ...init.headers } });
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
  const rpc = new JsonRpcProvider("http://127.0.0.1:8545");
  const signer = await rpc.getSigner(0);
  const address = await signer.getAddress();
  const challengeResponse = await request(`${base}/api/auth/challenge`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify({ address }) });
  if (!challengeResponse.ok) throw new Error(`Challenge failed: ${challengeResponse.status}`);
  const challenge = await challengeResponse.json() as { message: string };
  const signature = await signer.signMessage(challenge.message);
  const loginResponse = await request(`${base}/api/auth/verify`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify({ message: challenge.message, signature }) });
  if (!loginResponse.ok) throw new Error(`SIWE login failed: ${loginResponse.status}`);
  const login = await loginResponse.json() as { csrf: string; address: string };
  const verifier = randomBytes(32).toString("base64url");
  const challengeHash = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("hex");
  const auth = new URL(`${base}/auth`);
  for (const [key, value] of Object.entries({ client_id: "aichainpay-local-test", redirect_uri: callback, response_type: "code", scope: "wallet:read payments:prepare payments:execute", resource, state, code_challenge: challengeHash, code_challenge_method: "S256" })) auth.searchParams.set(key, value);
  let response = await follow(auth.href);
  const trace: string[] = [];
  for (let i = 0; i < 5; i++) {
    const location = response.headers.get("location");
    if (location?.startsWith(callback)) break;
    const current = response.url;
    if (!current.includes("/interaction/")) throw new Error(`Expected OAuth interaction, got ${response.status} at ${current}`);
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
  const code = parsed.searchParams.get("code");
  if (!code) throw new Error(`Authorization failed: ${parsed.searchParams.get("error") ?? "missing code"}`);
  const tokenResponse = await request(`${base}/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: "aichainpay-local-test", redirect_uri: callback, code, code_verifier: verifier, resource }) });
  if (!tokenResponse.ok) throw new Error(`Token exchange failed: ${tokenResponse.status}`);
  const token = await tokenResponse.json() as { access_token: string };
  const client = new Client({ name: "aichainpay-local-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(resource), { requestInit: { headers: { Authorization: `Bearer ${token.access_token}` } } });
  await client.connect(transport);
  const tools = await client.listTools();
  const balance = await client.callTool({ name: "get_contract_balance", arguments: {} });
  const history = await client.callTool({ name: "get_recent_transactions", arguments: { limit: 5 } });
  const disabled = await client.callTool({ name: "execute_payment", arguments: { request_id: "00000000-0000-4000-8000-000000000001", intent_digest: `0x${"0".repeat(64)}` } });
  if (balance.isError || history.isError || !disabled.isError) throw new Error("MCP tool behavior incorrect");
  const indexed = history.structuredContent?.result as { items: unknown[]; indexing_complete_through_latest_block: boolean };
  if (!indexed?.indexing_complete_through_latest_block) throw new Error("Local event indexer did not reach latest block");
  console.log(JSON.stringify({ local_chain: 31337, wallet: login.address, oauth: "authorization_code_pkce_passed", mcp_initialized: true, tools: tools.tools.map(x => x.name), balance_result: balance.structuredContent, indexed_vault_payments: indexed.items.length, execution_disabled: true }, null, 2));
  await client.close();
}

main().catch(error => { console.error(error instanceof Error ? error.message : "Local MCP test failed"); process.exitCode = 1; });
