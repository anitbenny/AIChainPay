import { chromium } from "playwright";
import { readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { getAddress } from "ethers";

type Manifest = { chainId: number; address: string; deploymentBlock: number };
type PublicConfig = { chainId: number; contractAddress: string; explorerUrl: string | null; executionEnabled: boolean };
type Health = { server: boolean; rpc: boolean; vault: boolean; execution_enabled: boolean };

async function main() {
  if (!existsSync("packages/shared/src/deployment.11155111.json")) {
    throw new Error("No Sepolia deployment manifest exists; deploy and verify the contract before capturing a Sepolia screenshot");
  }
  const manifest = JSON.parse(await readFile("packages/shared/src/deployment.11155111.json", "utf8")) as Manifest;
  if (manifest.chainId !== 11155111) throw new Error("The deployment manifest is not Sepolia");
  const base = new URL(process.env.AICHAINPAY_UI_URL ?? "http://localhost:3000");
  if (!((base.protocol === "http:" && ["localhost", "127.0.0.1"].includes(base.hostname)) || base.protocol === "https:")) {
    throw new Error("UI URL must be local HTTP or HTTPS");
  }
  if (base.pathname !== "/" || base.search || base.hash) throw new Error("UI URL must be an origin without path or query");
  const [configResponse, healthResponse] = await Promise.all([
    fetch(new URL("/api/config", base)), fetch(new URL("/health", base)),
  ]);
  if (!configResponse.ok || !healthResponse.ok) throw new Error("Sepolia connector is not ready");
  const config = await configResponse.json() as PublicConfig;
  const health = await healthResponse.json() as Health;
  if (config.chainId !== 11155111 || getAddress(config.contractAddress) !== getAddress(manifest.address)) {
    throw new Error("Frontend API chain/address does not match the Sepolia manifest");
  }
  if (!health.server || !health.rpc || !health.vault) throw new Error("Sepolia RPC or vault is not ready");
  if (config.executionEnabled || health.execution_enabled) throw new Error("Refusing read-only screenshot while payment execution is enabled");
  if (config.explorerUrl !== "https://sepolia.etherscan.io") throw new Error("Unexpected explorer URL");

  const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
  const browser = await chromium.launch({ executablePath: edge, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
    const pageErrors: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    await page.goto(base.href, { waitUntil: "networkidle" });
    await page.getByText("SEPOLIA TESTNET — TEST FUNDS ONLY").waitFor();
    await page.getByText("Connector online").waitFor();
    await page.getByText(manifest.address, { exact: true }).waitFor();
    const explorer = await page.getByRole("link", { name: "View in Sepolia explorer" }).first().getAttribute("href");
    if (explorer !== `https://sepolia.etherscan.io/address/${manifest.address}`) throw new Error("Vault explorer link does not match the deployment");
    if (pageErrors.length) throw new Error(`Sepolia UI page error: ${pageErrors[0]}`);
    const screenshot = resolve("docs", "screenshots", "sepolia-dashboard-unconnected.png");
    await mkdir(resolve("docs", "screenshots"), { recursive: true });
    await page.screenshot({ path: screenshot, fullPage: true });
    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await mobile.goto(base.href, { waitUntil: "networkidle" });
    const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    if (overflow) throw new Error("Sepolia dashboard has horizontal overflow at 390px");
    console.log(JSON.stringify({ chain_id: 11155111, contract: manifest.address, deployment_block: manifest.deploymentBlock,
      connector_ready: true, execution_disabled: true, wallet_connected: false, metamask_tested: false,
      screenshot, mobile_horizontal_overflow: false }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error instanceof Error ? error.message : "Sepolia UI capture failed"); process.exitCode = 1; });
