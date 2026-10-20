param([int]$Port = 3001)

$ErrorActionPreference = 'Stop'
if ($Port -lt 1024 -or $Port -gt 65535) { throw 'Choose an unprivileged TCP port.' }
$workspace = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $workspace 'packages/shared/src/deployment.11155111.json'
if (-not (Test-Path -LiteralPath $manifestPath)) { throw 'Verified Sepolia deployment manifest is missing.' }
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.chainId -ne 11155111) { throw 'Deployment manifest is not Sepolia.' }

Push-Location $workspace
try {
  # Parse only the RPC value. Never put the deployment key in this process.
  $rpcUrl = node -e "const fs=require('fs');const dotenv=require('dotenv');const value=dotenv.parse(fs.readFileSync('.env')).SEPOLIA_RPC_URL;if(!value)process.exit(2);process.stdout.write(value)"
  if ($LASTEXITCODE -ne 0 -or -not $rpcUrl) { throw 'Set SEPOLIA_RPC_URL in the root private .env file.' }
} finally { Pop-Location }

$secretBytes = New-Object byte[] 48
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
try {
  $rng.GetBytes($secretBytes)
  $env:SEPOLIA_RPC_URL = $rpcUrl
  $env:CHAIN_ID = '11155111'
  $env:ALLOW_LOCAL_CHAIN = '0'
  $env:CONTRACT_ADDRESS = $manifest.address
  $env:CONTRACT_CODE_HASH = $manifest.codeHash
  $env:CONTRACT_DEPLOYMENT_BLOCK = [string]$manifest.deploymentBlock
  $env:DATABASE_PATH = Join-Path $workspace 'connector/data/sepolia-readonly.sqlite'
  $env:PUBLIC_BASE_URL = "http://localhost:$Port"
  $env:OAUTH_ISSUER = $env:PUBLIC_BASE_URL
  $env:SESSION_SECRET = [Convert]::ToBase64String($secretBytes)
  $env:CONFIRMATION_ADAPTER = 'disabled'
  $env:CHATGPT_APPROVAL_TESTED = '0'
  $env:PORT = [string]$Port
  $env:LISTEN_HOST = '127.0.0.1'
  Remove-Item Env:DEPLOYER_PRIVATE_KEY -ErrorAction SilentlyContinue
  Remove-Item Env:AGENT_PRIVATE_KEY -ErrorAction SilentlyContinue
  Remove-Item Env:AGENT_ADDRESS -ErrorAction SilentlyContinue
  Write-Output "Starting read-only Sepolia dashboard at http://localhost:$Port; no agent signer and no payment execution."
  Push-Location (Join-Path $workspace 'connector')
  try { node --import tsx src/index.ts }
  finally { Pop-Location }
} finally {
  [Array]::Clear($secretBytes, 0, $secretBytes.Length)
  $rng.Dispose()
  Remove-Item Env:SESSION_SECRET -ErrorAction SilentlyContinue
  Remove-Item Env:SEPOLIA_RPC_URL -ErrorAction SilentlyContinue
}
