import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import { parse } from "dotenv";
import { JsonRpcProvider, Wallet, keccak256, parseUnits } from "ethers";

type Artifact = { abi: unknown[]; bytecode: string; deployedBytecode: string };

async function main() {
  const artifact = JSON.parse(readFileSync("artifacts/contracts/AIChainPay.sol/AIChainPay.json", "utf8")) as Artifact;
  const exportedAbi = JSON.parse(readFileSync("packages/shared/src/AIChainPay.abi.json", "utf8")) as unknown[];
  if (!artifact.bytecode?.startsWith("0x") || artifact.bytecode.length <= 2) throw new Error("Compiled deployment bytecode is missing");
  if (!artifact.deployedBytecode?.startsWith("0x") || artifact.deployedBytecode.length <= 2) throw new Error("Compiled runtime bytecode is missing");
  if (JSON.stringify(artifact.abi) !== JSON.stringify(exportedAbi)) throw new Error("Exported ABI does not match the compiled contract");

  const runtimeCodeHash = keccak256(artifact.deployedBytecode);
  const missing = ["SEPOLIA_RPC_URL", "DEPLOYER_PRIVATE_KEY"].filter(name => !process.env[name]);
  if (missing.length) {
    console.log(JSON.stringify({ artifact_ready: true, runtime_code_hash: runtimeCodeHash, network_ready: false, missing_local_settings: missing, broadcast: false }, null, 2));
    process.exitCode = 2;
    return;
  }

  const provider = new JsonRpcProvider(process.env.SEPOLIA_RPC_URL, undefined, { cacheTimeout: 0 });
  try {
    if ((await provider.getNetwork()).chainId !== 11155111n) throw new Error("RPC is not Sepolia chain 11155111");
    const deployer = new Wallet(process.env.DEPLOYER_PRIVATE_KEY!, provider);
    let agentSeparationChecked = false;
    if (existsSync("connector/.env")) {
      const connectorEnv = parse(readFileSync("connector/.env"));
      if (connectorEnv.DEPLOYER_PRIVATE_KEY) throw new Error("Deployer key must not be in connector/.env");
      if (connectorEnv.AGENT_PRIVATE_KEY) {
        agentSeparationChecked = true;
        if (new Wallet(connectorEnv.AGENT_PRIVATE_KEY).address === deployer.address) {
          throw new Error("Deployer and agent must be separate accounts");
        }
      }
    }
    const [balance, gas, fee] = await Promise.all([
      provider.getBalance(deployer.address),
      provider.estimateGas({ from: deployer.address, data: artifact.bytecode }),
      provider.getFeeData(),
    ]);
    const maxFeePerGas = fee.maxFeePerGas ?? fee.gasPrice;
    if (!maxFeePerGas) throw new Error("RPC did not provide a deployment gas price");
    // Hardhat may apply a 1 gwei fee floor even when a quiet Sepolia RPC
    // reports prices in tens of wei. Plan at no less than 2 gwei so the
    // funding check does not dramatically understate the likely cost.
    const planningFeePerGas = maxFeePerGas > parseUnits("2", "gwei") ? maxFeePerGas : parseUnits("2", "gwei");
    const estimatedPlanningCostWei = gas * planningFeePerGas;
    const fundingReady = balance >= estimatedPlanningCostWei;
    console.log(JSON.stringify({ artifact_ready: true, chain_id: 11155111, deployer_address: deployer.address,
      runtime_code_hash: runtimeCodeHash, deployment_bytecode_bytes: (artifact.bytecode.length - 2) / 2,
      estimated_gas: gas.toString(), rpc_max_fee_per_gas_wei: maxFeePerGas.toString(),
      planning_fee_per_gas_wei: planningFeePerGas.toString(), estimated_planning_cost_wei: estimatedPlanningCostWei.toString(),
      deployer_balance_wei: balance.toString(), agent_separation_checked: agentSeparationChecked,
      network_ready: true, funding_ready: fundingReady, broadcast: false }, null, 2));
    if (!fundingReady) process.exitCode = 2;
  } finally { provider.destroy(); }
}

main().catch(() => { console.error("Sepolia preflight failed; check RPC, keys, account separation, and test ETH locally. No transaction was sent."); process.exitCode = 1; });
