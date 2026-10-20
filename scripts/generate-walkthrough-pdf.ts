import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const input = resolve(root, "docs/AIChainPay_Technical_Walkthrough.html");
const output = resolve(root, "AIChainPay_Technical_Walkthrough.pdf");
const browserPaths = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  chromium.executablePath(),
];

if (!existsSync(input)) throw new Error("Technical walkthrough HTML source is missing");
const executablePath = browserPaths.find(path => existsSync(path));
if (!executablePath) throw new Error("Install Microsoft Edge, Chrome, or Playwright Chromium to render the PDF");

const browser = await chromium.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 1600 } });
  await page.goto(pathToFileURL(input).href, { waitUntil: "load" });
  await page.pdf({ path: output, format: "A4", printBackground: true, preferCSSPageSize: true });
  console.log(`Generated ${output}`);
} finally {
  await browser.close();
}
