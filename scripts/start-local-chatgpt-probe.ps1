param(
  [Parameter(Mandatory = $true)]
  [string]$PublicBaseUrl,
  [string]$DatabasePath
)

$ErrorActionPreference = 'Stop'
$uri = [uri]$PublicBaseUrl
if ($uri.Scheme -ne 'https' -or $uri.AbsolutePath -ne '/' -or $uri.Query -or $uri.Fragment) {
  throw 'PublicBaseUrl must be an HTTPS origin without a path, query, or fragment.'
}

$workspace = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $workspace 'packages/shared/src/deployment.31337.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.chainId -ne 31337) { throw 'The local deployment manifest must have chain ID 31337.' }

$env:CHAIN_ID = '31337'
$env:ALLOW_LOCAL_CHAIN = '1'
$env:SEPOLIA_RPC_URL = 'http://127.0.0.1:8545'
$env:CONTRACT_ADDRESS = $manifest.address
$env:CONTRACT_CODE_HASH = $manifest.codeHash
$env:CONTRACT_DEPLOYMENT_BLOCK = [string]$manifest.deploymentBlock
$env:AGENT_ADDRESS = '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc'
$env:DATABASE_PATH = if ($DatabasePath) { $DatabasePath } else { Join-Path $workspace 'connector/data/chatgpt-local-probe.sqlite' }
$env:PUBLIC_BASE_URL = $uri.GetLeftPart([System.UriPartial]::Authority)
$env:OAUTH_ISSUER = $env:PUBLIC_BASE_URL
$env:CONFIRMATION_ADAPTER = 'disabled'
$env:CHATGPT_APPROVAL_TESTED = '0'
$env:PORT = '3000'
$env:LISTEN_HOST = '127.0.0.1'
$env:DEV_FRONTEND_ORIGIN = 'http://localhost:3000'
Remove-Item Env:AGENT_PRIVATE_KEY -ErrorAction SilentlyContinue

$secretPath = Join-Path $workspace 'connector/data/chatgpt-session.dpapi'
$secretBytes = $null
Add-Type -AssemblyName System.Security
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
try {
  if (Test-Path -LiteralPath $secretPath) {
    $encrypted = [IO.File]::ReadAllBytes($secretPath)
    $secretBytes = [Security.Cryptography.ProtectedData]::Unprotect($encrypted, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Array]::Clear($encrypted, 0, $encrypted.Length)
  } else {
    $secretBytes = New-Object byte[] 48
    $rng.GetBytes($secretBytes)
    [IO.Directory]::CreateDirectory((Split-Path -Parent $secretPath)) | Out-Null
    $encrypted = [Security.Cryptography.ProtectedData]::Protect($secretBytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    try {
      $file = [IO.File]::Open($secretPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
      try { $file.Write($encrypted, 0, $encrypted.Length) }
      finally { $file.Dispose() }
    } finally { [Array]::Clear($encrypted, 0, $encrypted.Length) }
  }
  if ($secretBytes.Length -ne 48) { throw 'The protected session secret has an invalid length.' }
  $env:SESSION_SECRET = [Convert]::ToBase64String($secretBytes)
  Write-Output 'Starting local-chain ChatGPT probe; payment execution is disabled.'
  Push-Location $workspace
  try { npm.cmd run start -w connector }
  finally { Pop-Location }
}
finally {
  if ($secretBytes) { [Array]::Clear($secretBytes, 0, $secretBytes.Length) }
  $rng.Dispose()
  Remove-Item Env:SESSION_SECRET -ErrorAction SilentlyContinue
}
