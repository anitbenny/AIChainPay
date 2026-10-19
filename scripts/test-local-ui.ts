import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const base = "http://localhost:3000";

async function main() {
  const browser = await chromium.launch({ executablePath: edge, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1080 }, deviceScaleFactor: 1 });
    page.on("pageerror", error => console.error("Browser page error:", error.message));
    await page.addInitScript({ content: `(() => {
      const listeners = new Map();
      window.ethereum = {
        isMetaMask: true,
        request: async ({ method, params }) => {
          const mapped = method === "eth_requestAccounts" ? "eth_accounts" : method;
          const response = await fetch("http://127.0.0.1:8545", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: mapped, params: params ?? [] }) });
          const data = await response.json();
          if (data.error) throw new Error(data.error.message);
          return data.result;
        },
        on: (event, callback) => { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(callback); },
        removeListener: (event, callback) => { listeners.get(event)?.delete(callback); },
      };
    })();` });
    await page.goto(base, { waitUntil: "networkidle" });
    await page.getByText("LOCAL TEST CHAIN 31337").waitFor();
    const injectedState = await page.evaluate(async () => { try { const result = await (window as any).ethereum.request({ method: "eth_accounts" }); return { accountCount: result.length }; } catch (error) { return { error: error instanceof Error ? error.message : "unknown" }; } });
    if ("error" in injectedState) throw new Error(`Injected local test provider failed: ${injectedState.error}`);
    await page.getByRole("button", { name: "Sign expiring login challenge" }).click();
    await page.getByText("Wallet ownership verified.").waitFor({ timeout: 15_000 });
    await page.getByRole("button", { name: "Vault setup" }).click();
    await page.getByLabel("Deposit amount (ETH)").fill("0.02");
    await page.getByRole("button", { name: "Deposit with MetaMask" }).click();
    await page.getByText("Transaction mined:").waitFor({ timeout: 15_000 });
    await page.getByLabel("Total allowance (ETH)").fill("0.05");
    await page.getByLabel("Maximum per payment (ETH)").fill("0.01");
    await page.getByRole("button", { name: "Grant / replace with MetaMask" }).click();
    await page.getByText("Transaction mined:").waitFor({ timeout: 15_000 });
    await page.getByRole("button", { name: "Overview" }).click();
    await page.getByText("Active grant").waitFor({ timeout: 15_000 });
    const vaultBalance = await page.locator(".metric.accent strong").innerText();
    const out = resolve("docs", "screenshots", "local-chain-dashboard.png");
    await mkdir(resolve("docs", "screenshots"), { recursive: true });
    await page.screenshot({ path: out, fullPage: true });
    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
    await mobile.goto(base, { waitUntil: "networkidle" });
    const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    if (overflow) throw new Error("Mobile dashboard has horizontal overflow");
    console.log(JSON.stringify({ login: "passed", local_chain_deposit: "mined", local_chain_grant: "mined", dashboard_balance: `${vaultBalance} ETH`, screenshot: out, mobile_horizontal_overflow: false }, null, 2));
  } finally { await browser.close(); }
}

main().catch(error => { console.error(error instanceof Error ? error.message : "Browser test failed"); process.exitCode = 1; });
