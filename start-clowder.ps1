# =============================================================================
#  Clowder ONE-CLICK launcher  (proxy + trust-all + Redis + start)
# -----------------------------------------------------------------------------
#  Double-click start-clowder.cmd. This does everything; no manual steps:
#    1. sets the proxy for the API process and its kiro-cli acp children
#    2. installs a portable Redis on first run (into .cat-cafe\redis\windows)
#    3. starts Clowder (API + web) in persistent (Redis) mode
#  trust-all-tools is already baked into the Kiro ACP profile, so every Kiro
#  tool call (incl. nested subagents) is auto-approved -- nothing to confirm.
# =============================================================================
$repo     = $PSScriptRoot
$proxyUrl = "http://127.0.0.1:7890"
$redisDownloadUrl = "https://github.com/redis-windows/redis-windows/releases/download/8.8.0/Redis-8.8.0-Windows-x64-msys2.zip"

function Write-Step { param([string]$m) Write-Host "`n==> $m" -ForegroundColor Cyan }
function Write-Ok   { param([string]$m) Write-Host "  [OK] $m" -ForegroundColor Green }
function Write-Warn { param([string]$m) Write-Host "  [!!] $m" -ForegroundColor Yellow }
function Write-Err  { param([string]$m) Write-Host "  [ERR] $m" -ForegroundColor Red }

# --- 1) Proxy for CLI traffic (API process + every kiro-cli acp child) -------
$env:HTTP_PROXY  = $proxyUrl
$env:HTTPS_PROXY = $proxyUrl
$env:NO_PROXY    = "localhost,127.0.0.1,::1"

# TLS 1.2 + route .NET web requests through the proxy IF it is listening
# (needed for the one-time Redis download on Windows PowerShell 5.1).
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
$proxyUp = $false
try {
    $tcp = New-Object System.Net.Sockets.TcpClient
    $iar = $tcp.BeginConnect("127.0.0.1", 7890, $null, $null)
    $proxyUp = $iar.AsyncWaitHandle.WaitOne(800) -and $tcp.Connected
    $tcp.Close()
} catch { $proxyUp = $false }
if ($proxyUp) {
    Write-Ok "Proxy $proxyUrl is up (used for CLI traffic + Redis download)"
    $wp = New-Object System.Net.WebProxy($proxyUrl); $wp.BypassProxyOnLocal = $true
    [System.Net.WebRequest]::DefaultWebProxy = $wp
} else {
    Write-Warn "Proxy $proxyUrl not reachable - continuing; Redis download may fail if GitHub is blocked."
}

# Pin the one-click launcher to the portable, non-Service MSYS2 Redis bundle.
# To upgrade Redis later, replace this URL; the installer will update binaries
# while preserving .cat-cafe\redis\windows\data.
if (-not $env:CAT_CAFE_WINDOWS_REDIS_DOWNLOAD_URL) {
    $env:CAT_CAFE_WINDOWS_REDIS_DOWNLOAD_URL = $redisDownloadUrl
}

# --- 2) Ensure portable Redis (downloads once if missing; idempotent) --------
try {
    . (Join-Path $repo "scripts\install-windows-helpers.ps1")
    Write-Step "Ensuring Redis (portable, into .cat-cafe\redis\windows)"
    $redisOk = Ensure-WindowsRedis -ProjectRoot $repo
    if ($redisOk) { Write-Ok "Redis ready - starting in persistent (Redis) mode" }
    else { Write-Warn "Redis not ready - Clowder will fall back to in-memory (data lost on restart)" }
} catch {
    Write-Warn "Redis setup failed: $($_.Exception.Message)"
    Write-Warn "Clowder will still start (in-memory). Re-run once proxy/network is available to get Redis."
}

# --- 3) Start Clowder (default mode = Redis; trust-all is automatic) ---------
Set-Location $repo
Write-Step "Starting Clowder (API + web) ..."
pnpm start
