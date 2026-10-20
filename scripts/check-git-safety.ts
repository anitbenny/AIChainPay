import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// This is a conservative pre-publication check, not a substitute for reviewing
// every staged file and screenshot. Never print matching secret material.
const names = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" })
  .split("\0").filter(Boolean);
const findings: { file: string; category: string }[] = [];
const secretFile = /(^|\/)(?:\.env(?:\.[^/]*)?|[^/]+\.(?:sqlite(?:-wal|-shm)?|db|key|pem|jwk|signedtx))$/i;
const textFile = /\.(?:md|json|ts|tsx|js|mjs|cjs|sol|ps1|html|css|yml|yaml|toml|txt|example)$/i;
const secretPatterns: [string, RegExp][] = [
  ["private-key assignment", /(?:DEPLOYER_PRIVATE_KEY|AGENT_PRIVATE_KEY)\s*[:=]\s*["']?0x[0-9a-fA-F]{64}\b/],
  ["session or tunnel secret assignment", /(?:SESSION_SECRET|NGROK_AUTHTOKEN)\s*[:=]\s*["']?[A-Za-z0-9+/_=-]{32,}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/],
  ["OpenAI API key", /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ["private-key PEM", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
];
for (const file of names) {
  const normalized = file.replaceAll("\\", "/");
  if (secretFile.test(normalized) && !normalized.endsWith(".env.example")) {
    findings.push({ file: normalized, category: "secret-like filename" });
    continue;
  }
  if (!textFile.test(normalized)) continue;
  const value = readFileSync(file, "utf8");
  for (const [category, pattern] of secretPatterns) {
    if (pattern.test(value)) findings.push({ file: normalized, category });
  }
}
console.log(JSON.stringify({ checked_files: names.length, findings, manual_review_still_required: true }, null, 2));
if (findings.length) process.exitCode = 1;
