import { JsonRpcProvider, formatEther, getAddress, parseEther } from "ethers";

// The Hardhat node exposes this disposable, unlocked account on chain 31337.
// Never use this helper with a live RPC or a real-money wallet.
const LOCAL_CHAIN_ID = 31337n;
const LOCAL_FUNDER = getAddress("0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266");
const AMOUNT = parseEther("0.03");

async function main() {
  if (process.argv.length !== 3) throw new Error("Usage: npm.cmd run fund:local-owner -- <MetaMask owner address>");
  const owner = getAddress(process.argv[2]);
  if (owner === LOCAL_FUNDER) throw new Error("Owner must differ from the local funding account");

  const provider = new JsonRpcProvider("http://127.0.0.1:8545", undefined, { cacheTimeout: 0 });
  try {
    if ((await provider.getNetwork()).chainId !== LOCAL_CHAIN_ID) throw new Error("Refusing to fund: RPC is not local chain 31337");
    const accounts = await provider.send("eth_accounts", []) as string[];
    if (!accounts.some(account => getAddress(account) === LOCAL_FUNDER)) throw new Error("The expected unlocked Hardhat funding account is unavailable");
    const signer = await provider.getSigner(LOCAL_FUNDER);
    const tx = await signer.sendTransaction({ to: owner, value: AMOUNT });
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) throw new Error("Local funding transaction failed");
    console.log(JSON.stringify({ chain_id: 31337, owner, funded_eth: formatEther(AMOUNT), transaction_hash: tx.hash, owner_wallet_eth: formatEther(await provider.getBalance(owner)) }, null, 2));
  } finally {
    provider.destroy();
  }
}

main().catch(error => { console.error(error instanceof Error ? error.message : "Local funding failed"); process.exitCode = 1; });
