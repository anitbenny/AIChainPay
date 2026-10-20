import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { parse } from "dotenv";
import { JsonRpcProvider, Wallet, getAddress, keccak256 } from "ethers";
import Database from "better-sqlite3";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const connectorDir = resolve(root, "connector");
const configPath = resolve(connectorDir, ".env");
const agentPath = resolve(connectorDir, "data/sepolia-agent.key");

function httpsOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Supply a valid public HTTPS origin"); }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Public origin must be HTTPS without credentials, a path, query or fragment");
  }
  return url.origin;
}

async function setup() {
  const origin = httpsOrigin(process.argv[3] ?? "");
  if (existsSync(configPath)) throw new Error("connector/.env already exists; refusing to overwrite configuration");
  const deployment = JSON.parse(readFileSync(resolve(root, "packages/shared/src/deployment.11155111.json"), "utf8"));
  if (deployment.chainId !== 11155111) throw new Error("Deployment manifest is not Sepolia");
  const contract = getAddress(deployment.address);
  // Deployment secrets are read only during this one-shot setup. Only the RPC URL
  // is copied; the deployer key is never passed to the running connector.
  const deploymentEnv = parse(readFileSync(resolve(root, ".env")));
  const rpcUrl = deploymentEnv.SEPOLIA_RPC_URL;
  if (!rpcUrl) throw new Error("Root .env is missing SEPOLIA_RPC_URL");
  let provider: JsonRpcProvider | undefined;
  try {
    const url = new URL(rpcUrl);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error();
    provider = new JsonRpcProvider(rpcUrl);
    if ((await provider.getNetwork()).chainId !== 11155111n) throw new Error();
    const code = await provider.getCode(contract);
    if (code === "0x" || keccak256(code).toLowerCase() !== String(deployment.codeHash).toLowerCase()) throw new Error();
  } catch {
    throw new Error("Sepolia chain/bytecode check failed; configuration was not written and RPC credentials were not printed");
  } finally { provider?.destroy(); }

  mkdirSync(dirname(agentPath), { recursive: true });
  let agent: Wallet;
  try {
    agent = existsSync(agentPath) ? new Wallet(readFileSync(agentPath, "utf8").trim()) : new Wallet(Wallet.createRandom().privateKey);
    const owner = process.argv[4] ? getAddress(process.argv[4]) : undefined;
    const deployer = deploymentEnv.DEPLOYER_PRIVATE_KEY ? new Wallet(deploymentEnv.DEPLOYER_PRIVATE_KEY).address : undefined;
    if (agent.address === owner || agent.address === deployer) throw new Error();
  } catch { throw new Error("Agent identity must be valid and separate from owner/deployer"); }
  if (!existsSync(agentPath)) writeFileSync(agentPath, `${agent.privateKey}\n`, { flag: "wx", mode: 0o600 });

  const values: Record<string, string> = {
    SEPOLIA_RPC_URL: rpcUrl,
    CHAIN_ID: "11155111", ALLOW_LOCAL_CHAIN: "0",
    CONTRACT_ADDRESS: contract, CONTRACT_CODE_HASH: deployment.codeHash,
    CONTRACT_DEPLOYMENT_BLOCK: String(deployment.deploymentBlock),
    AGENT_ADDRESS: agent.address,
    DATABASE_PATH: "./data/sepolia-chat.sqlite",
    PUBLIC_BASE_URL: origin, OAUTH_ISSUER: origin,
    SESSION_SECRET: randomBytes(48).toString("base64"),
    CONFIRMATION_ADAPTER: "disabled", CHATGPT_APPROVAL_TESTED: "0",
    REQUEST_TTL_SECONDS: "600", REQUIRED_CONFIRMATIONS: "2",
    PORT: "3000", LISTEN_HOST: "127.0.0.1",
  };
  writeFileSync(configPath, "# Sepolia setup. Agent key stays in ignored data/sepolia-agent.key and is NOT loaded.\n" +
    Object.entries(values).map(([name, value]) => `${name}=${JSON.stringify(value)}`).join("\n") + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ chain_id: 11155111, contract, agent_address: agent.address,
    dashboard: origin, mcp_url: `${origin}/mcp`, execution_enabled: false, signer_loaded: false,
    configuration_created: true, transactions_sent: 0 }, null, 2));
}

function start() {
  if (!existsSync(configPath)) throw new Error("Run setup:sepolia-connector first");
  const config = parse(readFileSync(configPath));
  const origin = httpsOrigin(config.PUBLIC_BASE_URL);
  if (config.CHAIN_ID !== "11155111" || config.OAUTH_ISSUER !== origin || config.ALLOW_LOCAL_CHAIN === "1") {
    throw new Error("Expected Sepolia-only configuration with a matching HTTPS issuer");
  }
  const env: NodeJS.ProcessEnv = { ...process.env, ...config, ALLOW_LOCAL_CHAIN: "0", CONFIRMATION_ADAPTER: "disabled", CHATGPT_APPROVAL_TESTED: "0", AGENT_PRIVATE_KEY: "" };
  if (process.argv.includes("--live")) {
    if (config.CONFIRMATION_ADAPTER !== "chatgpt_app" || config.CHATGPT_APP_APPROVAL_TESTED !== "1") {
      throw new Error("Live start requires locally recorded CHATGPT_APP_APPROVAL_TESTED=1 and CONFIRMATION_ADAPTER=chatgpt_app after actual in-chat card verification");
    }
    const db = new Database(resolve(connectorDir, config.DATABASE_PATH), { readonly: true });
    try {
      const decisions = db.prepare("SELECT detail FROM audit_entries WHERE action='chat_card_decision'").all() as {detail:string}[];
      const verified = decisions.map(row => JSON.parse(row.detail)).filter(row => row.mode === "verify");
      if (!verified.some(row => row.decision === "approve") || !verified.some(row => row.decision === "reject")) {
        throw new Error("Live start requires recorded verification-mode card approval AND rejection; synthetic tests in other databases do not qualify");
      }
    } finally { db.close(); }
    let key: string;
    try {
      key = readFileSync(agentPath, "utf8").trim();
      if (new Wallet(key).address !== getAddress(config.AGENT_ADDRESS)) throw new Error();
    } catch { throw new Error("Local agent key is unavailable or does not match configured agent address"); }
    env.CONFIRMATION_ADAPTER = "chatgpt_app";
    env.CHATGPT_APP_APPROVAL_TESTED = "1";
    env.AGENT_PRIVATE_KEY = key;
  }
  // Empty AGENT_PRIVATE_KEY also prevents dotenv from loading a signer from disk.
  delete env.DEPLOYER_PRIVATE_KEY;
  delete env.EXPLORER_API_KEY;
  delete env.DOTENV_CONFIG_PATH;
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], { cwd: connectorDir, env, stdio: "inherit", windowsHide: true });
  child.on("error", () => { console.error("Unable to start the Sepolia connector"); process.exitCode = 1; });
  child.on("exit", code => { process.exitCode = code ?? 1; });
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
}

async function main() {
  if (process.argv[2] === "setup") await setup();
  else if (process.argv[2] === "start") start();
  else throw new Error("Usage: sepolia-connector.ts setup <https-origin> [owner-address] | start");
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Sepolia connector setup failed"); process.exitCode = 1; });
