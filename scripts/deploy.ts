import { network, artifacts } from "hardhat";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { keccak256 } from "ethers";

async function main() {
  const { ethers, networkName } = await network.create();
  const chainId = (await ethers.provider.getNetwork()).chainId;
  if (networkName === "sepolia" && chainId !== 11155111n) throw new Error("Sepolia chain ID mismatch");
  if (networkName !== "sepolia" && chainId !== 31337n) throw new Error("Only explicit local chain 31337 or Sepolia is allowed");
  const vault = await ethers.deployContract("AIChainPay");
  await vault.waitForDeployment();
  const tx = vault.deploymentTransaction();
  const receipt = await tx?.wait();
  if (!tx || !receipt || receipt.status !== 1) throw new Error("Deployment receipt unavailable or failed");
  const address = await vault.getAddress();
  const artifact = await artifacts.readArtifact("AIChainPay");
  const manifest = {
    network: networkName,
    chainId: Number(chainId),
    address,
    deploymentBlock: receipt.blockNumber,
    deploymentTransactionHash: tx.hash,
    codeHash: keccak256(await ethers.provider.getCode(address)),
  };
  const out = join(process.cwd(), "packages", "shared", "src");
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "AIChainPay.abi.json"), JSON.stringify(artifact.abi, null, 2) + "\n");
  await writeFile(join(out, `deployment.${Number(chainId)}.json`), JSON.stringify(manifest, null, 2) + "\n");
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
