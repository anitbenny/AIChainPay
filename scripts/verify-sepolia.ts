import "dotenv/config";
import { readFile } from "node:fs/promises";
import { Interface, JsonRpcProvider, getAddress, keccak256 } from "ethers";
import { VAULT_ABI } from "@aichainpay/shared";

type Manifest = {
  chainId: number; address: string; deploymentBlock: number;
  deploymentTransactionHash: string; codeHash: string;
};

async function main() {
  const rpcUrl = process.env.SEPOLIA_RPC_URL;
  if (!rpcUrl) throw new Error("Set SEPOLIA_RPC_URL locally; no credentials are printed");
  const manifest = JSON.parse(await readFile("packages/shared/src/deployment.11155111.json", "utf8")) as Manifest;
  if (manifest.chainId !== 11155111) throw new Error("Manifest is not Sepolia");
  const provider = new JsonRpcProvider(rpcUrl, undefined, { cacheTimeout: 0 });
  if ((await provider.getNetwork()).chainId !== 11155111n) throw new Error("RPC is not Sepolia");
  const address = getAddress(manifest.address);
  const code = await provider.getCode(address);
  if (code === "0x" || keccak256(code).toLowerCase() !== manifest.codeHash.toLowerCase()) throw new Error("Live vault bytecode does not match the manifest");
  const artifact = JSON.parse(await readFile("artifacts/contracts/AIChainPay.sol/AIChainPay.json", "utf8")) as { abi: unknown[]; deployedBytecode: string };
  if (keccak256(artifact.deployedBytecode).toLowerCase() !== manifest.codeHash.toLowerCase()) throw new Error("Compiled runtime bytecode does not match the deployment");
  const exported = JSON.parse(await readFile("packages/shared/src/AIChainPay.abi.json", "utf8")) as unknown[];
  if (JSON.stringify(exported) !== JSON.stringify(artifact.abi)) throw new Error("Exported ABI differs from the compiled artifact");
  const full = new Interface(artifact.abi);
  for (const fragment of new Interface(VAULT_ABI).fragments) {
    if (fragment.type === "function" && !full.getFunction(fragment.format("sighash"))) throw new Error(`Shared ABI function missing: ${fragment.format("sighash")}`);
    if (fragment.type === "event" && !full.getEvent(fragment.format("sighash"))) throw new Error(`Shared ABI event missing: ${fragment.format("sighash")}`);
  }
  const receipt = await provider.getTransactionReceipt(manifest.deploymentTransactionHash);
  if (!receipt || receipt.status !== 1 || receipt.blockNumber !== manifest.deploymentBlock || receipt.contractAddress?.toLowerCase() !== address.toLowerCase()) throw new Error("Deployment transaction receipt does not match the manifest");
  console.log(JSON.stringify({ chain_id: 11155111, address, code_hash: manifest.codeHash, deployment_block: receipt.blockNumber,
    deployment_transaction: manifest.deploymentTransactionHash, explorer: `https://sepolia.etherscan.io/address/${address}`, verification: "RPC chain, live bytecode, compiled bytecode, ABI and deployment receipt matched" }, null, 2));
  provider.destroy();
}

main().catch(error => { console.error(error instanceof Error ? error.message : "Verification failed"); process.exitCode = 1; });
