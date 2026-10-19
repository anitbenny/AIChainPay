import { Contract, JsonRpcProvider, Interface, keccak256 } from "ethers";
import { VAULT_ABI } from "@aichainpay/shared";
import type { Config } from "../config.js";

export class ChainService {
  readonly provider: JsonRpcProvider;
  readonly vault: Contract;
  readonly iface: Interface;

  constructor(readonly config: Config) {
    this.provider = new JsonRpcProvider(config.rpcUrl, undefined, { cacheTimeout: 0 });
    this.iface = new Interface(VAULT_ABI);
    this.vault = new Contract(config.contractAddress, VAULT_ABI, this.provider);
  }

  async check(): Promise<{ chainId: number; codeHash: string; blockNumber: number }> {
    const chainId = Number((await this.provider.getNetwork()).chainId);
    if (chainId !== this.config.chainId) throw new Error("RPC chain ID mismatch");
    const code = await this.provider.getCode(this.config.contractAddress);
    if (code === "0x") throw new Error("Configured vault has no bytecode");
    const memoMax = await this.vault.MAX_MEMO_BYTES();
    if (memoMax !== 140n) throw new Error("Vault ABI identity check failed");
    const codeHash = keccak256(code);
    if (this.config.contractCodeHash && codeHash.toLowerCase() !== this.config.contractCodeHash.toLowerCase()) throw new Error("Vault bytecode hash does not match deployment manifest");
    return { chainId, codeHash, blockNumber: await this.provider.getBlockNumber() };
  }

  async balance(owner: string): Promise<bigint> { return await this.vault.getBalance(owner) as bigint; }

  async permission(owner: string, agent: string) {
    const p = await this.vault.getAgentPermission(owner, agent);
    return {
      active: Boolean(p.active),
      remainingAllowance: BigInt(p.remainingAllowance),
      maxPerPayment: BigInt(p.maxPerPayment),
      expiresAt: Number(p.expiresAt),
      epoch: BigInt(p.epoch),
      restrictedRecipients: Boolean(p.restrictedRecipients),
    };
  }

  async allowed(owner: string, agent: string, recipient: string): Promise<boolean> {
    return await this.vault.isAllowedRecipient(owner, agent, recipient) as boolean;
  }
}
