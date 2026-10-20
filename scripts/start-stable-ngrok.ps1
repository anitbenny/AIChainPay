param(
  [Parameter(Mandatory = $true)]
  [string]$PublicBaseUrl,
  [switch]$AllowLiveConnector
)

$ErrorActionPreference = 'Stop'
$uri = [uri]$PublicBaseUrl
if ($uri.Scheme -ne 'https' -or $uri.AbsolutePath -ne '/' -or $uri.Query -or $uri.Fragment -or
    $uri.Host -notmatch '^[a-z0-9-]+\.(ngrok-free\.dev|ngrok\.app)$') {
  throw 'PublicBaseUrl must be your assigned HTTPS ngrok domain origin.'
}
if (-not (Get-Command ngrok -ErrorAction SilentlyContinue)) { throw 'Install the official ngrok Windows agent first.' }

$origin = $uri.GetLeftPart([System.UriPartial]::Authority)
$localConfig = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/config' -TimeoutSec 5
if ($localConfig.mcpUrl -ne "$origin/mcp") {
  throw 'Local connector does not advertise this exact MCP URL.'
}
if ($localConfig.executionEnabled -and -not $AllowLiveConnector) {
  throw 'Local connector has payment execution enabled. Pass -AllowLiveConnector only if you intend to expose the live connector.'
}
if ($localConfig.executionEnabled) {
  Write-Warning 'The live payment connector will be publicly reachable. Existing on-chain grant limits and in-chat confirmation still apply.'
}

$secure = Read-Host 'Enter your ngrok authtoken locally (input hidden; never paste it into chat)' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $env:NGROK_AUTHTOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  Write-Output 'Starting the assigned ngrok HTTPS endpoint; request inspection is disabled. Leave this terminal open.'
  & ngrok http 3000 --url $origin --inspect=false
} finally {
  Remove-Item Env:NGROK_AUTHTOKEN -ErrorAction SilentlyContinue
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  $secure.Dispose()
}
