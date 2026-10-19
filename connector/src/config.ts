import { normalizeAddress } from "@aichainpay/shared";
import { Wallet } from "ethers";

export type Config = {
  chainId: 11155111 | 31337;
  rpcUrl: string;
  contractAddress: string;
  contractCodeHash?: string;
  deploymentBlock: number;
  agentKey?: string;
  agentAddress?: string;
  databasePath: string;
  publicBaseUrl: string;
  issuer: string;
  sessionSecret: string;
  confirmationAdapter: "disabled" | "chatgpt_native";
  requestTtlSeconds: number;
  requiredConfirmations: number;
  port: number;
};

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be configured`);
  return value;
}

export function loadConfig(): Config {
  const chainId = Number(process.env.CHAIN_ID ?? "11155111");
  if (chainId !== 11155111 && !(chainId === 31337 && process.env.ALLOW_LOCAL_CHAIN === "1")) {
    throw new Error("Only Sepolia is supported; chain 31337 requires explicit ALLOW_LOCAL_CHAIN=1 for tests");
  }
  const publicBaseUrl = new URL(required("PUBLIC_BASE_URL"));
  const issuer = new URL(process.env.OAUTH_ISSUER || publicBaseUrl.href);
  if (publicBaseUrl.pathname !== "/" || issuer.pathname !== "/") throw new Error("Base URL and issuer must be origins");
  if (publicBaseUrl.origin !== issuer.origin) throw new Error("OAuth issuer must match the public base origin");
  if (chainId === 11155111 && publicBaseUrl.protocol !== "https:" && publicBaseUrl.hostname !== "localhost") {
    throw new Error("Public Sepolia endpoint requires HTTPS");
  }
  const sessionSecret = required("SESSION_SECRET");
  if (sessionSecret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");
  const adapter = process.env.CONFIRMATION_ADAPTER ?? "disabled";
  if (adapter !== "disabled" && adapter !== "chatgpt_native") throw new Error("Unknown confirmation adapter");
  if (adapter === "chatgpt_native" && (process.env.CHATGPT_APPROVAL_TESTED !== "1" || chainId !== 11155111 || publicBaseUrl.protocol !== "https:")) {
    throw new Error("ChatGPT native approval requires recorded live confirmation test, Sepolia and HTTPS");
  }
  const rpcUrl = new URL(required("SEPOLIA_RPC_URL"));
  if (!["http:", "https:"].includes(rpcUrl.protocol)) throw new Error("RPC URL must be HTTP(S)");
  const deploymentBlock = Number(required("CONTRACT_DEPLOYMENT_BLOCK"));
  if (!Number.isSafeInteger(deploymentBlock) || deploymentBlock < 0) throw new Error("Invalid deployment block");
  const requestTtlSeconds = Number(process.env.REQUEST_TTL_SECONDS ?? 600);
  const requiredConfirmations = Number(process.env.REQUIRED_CONFIRMATIONS ?? 2);
  if (!Number.isSafeInteger(requestTtlSeconds) || requestTtlSeconds < 60 || requestTtlSeconds > 3600) throw new Error("Invalid request TTL");
  if (!Number.isSafeInteger(requiredConfirmations) || requiredConfirmations < 1 || requiredConfirmations > 12) throw new Error("Invalid confirmation count");
  const agentKey = process.env.AGENT_PRIVATE_KEY || undefined;
  if (agentKey && !/^0x[0-9a-fA-F]{64}$/.test(agentKey)) throw new Error("Invalid agent key format");
  const agentAddress = agentKey ? new Wallet(agentKey).address : process.env.AGENT_ADDRESS ? normalizeAddress(process.env.AGENT_ADDRESS) : undefined;
  if (adapter === "chatgpt_native" && !agentKey) throw new Error("Dedicated agent key required for enabled execution");
  const contractCodeHash = process.env.CONTRACT_CODE_HASH || undefined;
  if (chainId === 11155111 && !contractCodeHash) throw new Error("CONTRACT_CODE_HASH from the deployment manifest is required on Sepolia");
  if (contractCodeHash && !/^0x[0-9a-fA-F]{64}$/.test(contractCodeHash)) throw new Error("Invalid contract code hash");
  return {
    chainId: chainId as 11155111 | 31337,
    rpcUrl: rpcUrl.href,
    contractAddress: normalizeAddress(required("CONTRACT_ADDRESS")),
    contractCodeHash,
    deploymentBlock,
    agentKey,
    agentAddress,
    databasePath: process.env.DATABASE_PATH ?? "./data/aichainpay.sqlite",
    publicBaseUrl: publicBaseUrl.origin,
    issuer: issuer.origin,
    sessionSecret,
    confirmationAdapter: adapter,
    requestTtlSeconds,
    requiredConfirmations,
    port: Number(process.env.PORT ?? 3000),
  };
}
