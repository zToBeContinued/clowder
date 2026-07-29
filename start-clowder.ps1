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
$repo = [System.IO.Path]::GetFullPath($PSScriptRoot)
Set-Location -LiteralPath $repo
. (Join-Path $repo "scripts\windows-runtime-env.ps1")
Initialize-ClowderWindowsRuntimeEnvironment -ProjectRoot $repo | Out-Null

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

# --- 3) Keep kiro-cli current (breaks the installer re-download loop) --------
#
# Root cause of the kiro-installer-*.msi pile in .cat-cafe\runtime\tmp: whenever the
# installed kiro-cli is behind the published release, its updater starts a full ~238MB
# installer download on EVERY process launch, but the msiexec step can never land inside
# a long-lived `acp` carrier -- so each cold start re-downloads the same MSI and throws it
# away. Downloads therefore scale 1:1 with cold starts (measured: 28 files / 5.33GB in
# ~8 hours). Neither the app.disableAutoupdates setting (verified effective yet ignored on
# the acp path) nor KIRO_NO_AUTO_UPDATE stops it -- both were reproduced with an isolated
# TEMP. Applying the update here instead, in a short-lived foreground process where msiexec
# can actually finish, removes the reason to download at all.
#
# Runs after the proxy block on purpose (the updater needs network). Never fatal: a missing
# kiro-cli, a network failure or a hung updater only warns and lets Clowder start.
function Invoke-KiroCliCommand {
    param(
        [Parameter(Mandatory = $true)][string]$Exe,
        [Parameter(Mandatory = $true)][string[]]$KiroArgs,
        [Parameter(Mandatory = $true)][int]$TimeoutSec
    )

    # Deliberately .NET Process instead of Start-Process: with redirected streams,
    # Start-Process -PassThru leaves ExitCode empty even after WaitForExit + Refresh,
    # which made a successful update look like a failure.
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    # ProcessStartInfo.ArgumentList does not exist on .NET Framework (Windows PowerShell
    # 5.1), so the arguments are joined. Safe here: every argument is a fixed literal
    # defined in this script, never user input.
    if ($Exe -match "\.(cmd|bat)$") {
        # CreateProcess cannot launch a batch shim directly -- route it through cmd.exe.
        $psi.FileName = "$env:SystemRoot\System32\cmd.exe"
        $psi.Arguments = "/d /c `"$Exe`" " + ($KiroArgs -join " ")
    } else {
        $psi.FileName = $Exe
        $psi.Arguments = ($KiroArgs -join " ")
    }
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.RedirectStandardInput = $true

    $proc = [System.Diagnostics.Process]::Start($psi)
    # Closing stdin gives the updater an immediate EOF, so it can never block the launcher
    # waiting on an interactive confirmation.
    $proc.StandardInput.Close()
    # Read both pipes concurrently: draining only one risks a deadlock on a full buffer.
    $stdoutTask = $proc.StandardOutput.ReadToEndAsync()
    $stderrTask = $proc.StandardError.ReadToEndAsync()

    if (-not $proc.WaitForExit($TimeoutSec * 1000)) {
        try { $proc.Kill() } catch {}
        return [pscustomobject]@{ TimedOut = $true; ExitCode = $null; Output = "" }
    }
    $out = ""
    $err = ""
    try { $out = [string]$stdoutTask.Result } catch {}
    try { $err = [string]$stderrTask.Result } catch {}
    return [pscustomobject]@{ TimedOut = $false; ExitCode = $proc.ExitCode; Output = ($out + "`n" + $err) }
}

function Resolve-KiroCliPath {
    $found = Get-Command "kiro-cli" -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($found) { return $found.Source }
    # Same fallback the API uses (see packages/api/src/utils/cli-resolve.ts): the official
    # Windows installer drops the binary here and does not always land on PATH.
    if ($env:LOCALAPPDATA) {
        $candidate = Join-Path $env:LOCALAPPDATA "Kiro-Cli\kiro-cli.exe"
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    return $null
}

Write-Step "Checking kiro-cli for updates"
try {
    $kiroExe = Resolve-KiroCliPath
    if (-not $kiroExe) {
        Write-Ok "kiro-cli not installed - nothing to check"
    } else {
        $check = Invoke-KiroCliCommand -Exe $kiroExe -KiroArgs @("update", "--check") -TimeoutSec 90
        if ($check.TimedOut) {
            Write-Warn "kiro-cli update --check timed out - continuing without updating"
        } elseif ($check.Output -match "Update available") {
            $line = ($check.Output -split "`r?`n" | Where-Object { $_ -match "Update available" } | Select-Object -First 1).Trim()
            Write-Warn "$line - installing now (one download instead of one per cold start)"
            $apply = Invoke-KiroCliCommand -Exe $kiroExe -KiroArgs @("update") -TimeoutSec 1800
            if ($apply.TimedOut) {
                Write-Warn "kiro-cli update timed out - continuing; it will be retried next launch"
            } elseif ($apply.ExitCode -ne 0) {
                Write-Warn "kiro-cli update failed (exit $($apply.ExitCode)) - continuing; it will be retried next launch"
            } else {
                $version = Invoke-KiroCliCommand -Exe $kiroExe -KiroArgs @("--version") -TimeoutSec 60
                $shown = if ($version.TimedOut) { "unknown" } else { ($version.Output).Trim() }
                Write-Ok "kiro-cli updated - now $shown"
            }
        } else {
            Write-Ok "kiro-cli is already on the current version"
        }
    }
} catch {
    Write-Warn "kiro-cli update check failed: $($_.Exception.Message)"
    Write-Warn "Continuing - a stale kiro-cli only costs bandwidth, it does not block Clowder."
}

# --- 4) Start Clowder (default mode = Redis; trust-all is automatic) ---------
Write-Step "Starting Clowder (API + web) ..."
& node (Join-Path $repo "scripts\start-entry.mjs") start
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}
