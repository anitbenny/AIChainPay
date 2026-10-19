import { getAddress, parseEther } from "ethers";

export const SEPOLIA_CHAIN_ID = 11155111n;
export const LOCAL_CHAIN_ID = 31337n;
export const EXPLORER_BASE_URL = "https://sepolia.etherscan.io";
export const MAX_MEMO_BYTES = 140;
export const VAULT_ABI = [
  "function MAX_MEMO_BYTES() view returns (uint256)",
  "function deposit() payable",
  "function withdraw(uint256 amount)",
  "function grantAgent(address agent,uint256 totalAllowance,uint256 maxPerPayment,uint64 expiresAt,address[] recipients)",
  "function revokeAgent(address agent)",
  "function pay(address recipient,uint256 amount,string memo,bytes32 requestId)",
  "function getBalance(address owner) view returns (uint256)",
  "function getAgentPermission(address owner,address agent) view returns (tuple(bool active,uint256 remainingAllowance,uint256 maxPerPayment,uint64 expiresAt,uint256 epoch,bool restrictedRecipients))",
  "function isAllowedRecipient(address owner,address agent,address recipient) view returns (bool)",
  "function getPaymentCount(address participant) view returns (uint256)",
  "function getPayment(address participant,uint256 index) view returns (tuple(uint256 id,address owner,address recipient,address executor,uint256 amount,string memo,bytes32 requestId,uint64 timestamp))",
  "function executeAgentPayment(address owner,address recipient,uint256 amount,string memo,bytes32 requestId,uint256 permissionEpoch,uint64 requestDeadline)",
  "event PaymentExecuted(address indexed owner,address indexed recipient,bytes32 indexed requestId,uint256 paymentId,address executor,uint256 amount,string memo,uint64 timestamp)",
] as const;

export function parseAmountEth(value: string): bigint {
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/.test(value)) throw new Error("Amount must be a plain positive decimal with at most 18 places");
  const wei = parseEther(value);
  if (wei <= 0n) throw new Error("Amount must be greater than zero");
  return wei;
}

export function normalizeAddress(value: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error("A 20-byte Ethereum address is required; ENS is not supported");
  return getAddress(value);
}

export function validateMemo(value: string): string {
  if (new TextEncoder().encode(value).length > MAX_MEMO_BYTES) throw new Error("Memo exceeds 140 UTF-8 bytes");
  return value;
}
