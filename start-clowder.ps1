# =============================================================================
#  Clowder ONE-CLICK launcher  (proxy + trust-all + Redis + start)
# -----------------------------------------------------------------------------
#  Double-click start-clowder.cmd. This does everything; no manual steps:
#    1. sets the proxy for the API process and its kiro-cli acp children
#    2. installs a portable Redis on first run (into .cat-cafe\redis\windows)
#    3. keeps kiro-cli current, then sweeps the caches its updater leaves behind
#    4. starts Clowder (API + web) in persistent (Redis) mode
#  trust-all-tools is already baked into the Kiro ACP profile, so every Kiro
#  tool call (incl. nested subagents) is auto-approved -- nothing to confirm.
#
#  Switches (forwarded to scripts/start-entry.mjs -> start-windows.ps1):
#    -Dev    web runs `next dev` (hot reload), API runs NODE_ENV=development
#    -Debug  LOG_LEVEL=debug + pino file logging (packages/api/data/logs/api/)
#    -Quick  skip package builds (use only when dist/.next are already fresh)
#  start-clowder-dev.cmd wraps this file with -Dev -Debug for UI iteration.
# =============================================================================
param(
    [switch]$Dev,
    [switch]$Debug,
    [switch]$Quick
)
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

# --- 3) Keep vendor CLIs current: kiro-cli / grok / cursor-agent -------------
#
# These three ship their own updaters (not npm), so `pnpm install` never touches
# them. Updating here -- in a short-lived foreground process, after the proxy
# block -- is the only place where the download and the install step can both
# finish. Every CLI is optional and never fatal: missing binary, dead network or
# a hung updater only warns and lets Clowder start.
#
# grok needs the proxy block above to have run: it fetches from
# storage.googleapis.com, which is the slow/blocked leg on this machine
# (measured: 69s direct vs 2s through 7890). kiro-cli and cursor-agent reach
# their endpoints directly and ignore HTTP_PROXY entirely.
#
# Only kiro-cli uses the two-phase check-then-apply path; the root cause below
# is specific to it. grok and cursor-agent decide for themselves and just print
# "already up to date", so a single call is enough.
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
function Invoke-CliUpdaterCommand {
    param(
        [Parameter(Mandatory = $true)][string]$Exe,
        [Parameter(Mandatory = $true)][string[]]$CliArgs,
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
        $psi.Arguments = "/d /c `"$Exe`" " + ($CliArgs -join " ")
    } else {
        $psi.FileName = $Exe
        $psi.Arguments = ($CliArgs -join " ")
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

function Resolve-VendorCliPath {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [string]$FallbackPath
    )

    # -CommandType Application on purpose: it skips .ps1 shims (ExternalScript) and
    # picks the .cmd/.exe, which is what CreateProcess can actually launch. Matters
    # for cursor-agent, which ships both.
    $found = Get-Command $Command -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($found) { return $found.Source }
    # Same fallbacks the API uses (see packages/api/src/utils/cli-resolve.ts): these
    # installers drop the binary in a fixed place and write PATH into the registry,
    # which an already-running process never sees.
    if ($FallbackPath -and (Test-Path -LiteralPath $FallbackPath -PathType Leaf)) {
        return $FallbackPath
    }
    return $null
}

function Get-VendorCliTargets {
    $targets = @()

    $kiroFallback = $null
    if ($env:LOCALAPPDATA) { $kiroFallback = Join-Path $env:LOCALAPPDATA "Kiro-Cli\kiro-cli.exe" }
    $targets += [pscustomobject]@{
        Name         = "kiro-cli"
        Command      = "kiro-cli"
        FallbackPath = $kiroFallback
        CheckArgs    = @("update", "--check")
        CheckPattern = "Update available"
        StaleNote    = "a stale kiro-cli only costs bandwidth"
    }

    # xAI Grok Build: install.ps1 drops it here and prepends the dir to User PATH.
    $grokFallback = $null
    if ($env:USERPROFILE) { $grokFallback = Join-Path $env:USERPROFILE ".grok\bin\grok.exe" }
    $targets += [pscustomobject]@{
        Name         = "grok"
        Command      = "grok"
        FallbackPath = $grokFallback
        CheckArgs    = $null
        CheckPattern = $null
        StaleNote    = "a stale grok only costs bandwidth"
    }

    $cursorFallback = $null
    if ($env:LOCALAPPDATA) { $cursorFallback = Join-Path $env:LOCALAPPDATA "cursor-agent\cursor-agent.cmd" }
    $targets += [pscustomobject]@{
        Name         = "cursor-agent"
        Command      = "cursor-agent"
        FallbackPath = $cursorFallback
        CheckArgs    = $null
        CheckPattern = $null
        StaleNote    = "a stale cursor-agent only costs bandwidth"
    }

    return $targets
}

function Update-VendorCli {
    param([Parameter(Mandatory = $true)][pscustomobject]$Target)

    $exe = Resolve-VendorCliPath -Command $Target.Command -FallbackPath $Target.FallbackPath
    if (-not $exe) {
        Write-Ok "$($Target.Name) not installed - nothing to check"
        return
    }

    if ($Target.CheckArgs) {
        $check = Invoke-CliUpdaterCommand -Exe $exe -CliArgs $Target.CheckArgs -TimeoutSec 90
        if ($check.TimedOut) {
            Write-Warn "$($Target.Name) update --check timed out - continuing without updating"
            return
        }
        if ($check.Output -notmatch $Target.CheckPattern) {
            Write-Ok "$($Target.Name) is already on the current version"
            return
        }
        $line = ($check.Output -split "`r?`n" |
            Where-Object { $_ -match $Target.CheckPattern } |
            Select-Object -First 1).Trim()
        Write-Warn "$line - installing now (one download instead of one per cold start)"
    }

    # 1800s: grok pulls a ~135MB payload, kiro-cli a ~238MB installer.
    $apply = Invoke-CliUpdaterCommand -Exe $exe -CliArgs @("update") -TimeoutSec 1800
    if ($apply.TimedOut) {
        Write-Warn "$($Target.Name) update timed out - continuing; it will be retried next launch"
        return
    }
    if ($apply.ExitCode -ne 0) {
        Write-Warn "$($Target.Name) update failed (exit $($apply.ExitCode)) - continuing; it will be retried next launch"
        return
    }
    if ($apply.Output -match "(?i)already up to date") {
        Write-Ok "$($Target.Name) is already on the current version"
        return
    }
    $version = Invoke-CliUpdaterCommand -Exe $exe -CliArgs @("--version") -TimeoutSec 60
    $shown = "unknown"
    if (-not $version.TimedOut) { $shown = ($version.Output).Trim() }
    Write-Ok "$($Target.Name) updated - now $shown"
}

foreach ($target in Get-VendorCliTargets) {
    Write-Step "Checking $($target.Name) for updates"
    try {
        Update-VendorCli -Target $target
    } catch {
        Write-Warn "$($target.Name) update check failed: $($_.Exception.Message)"
        Write-Warn "Continuing - $($target.StaleNote), it does not block Clowder."
    }
}

# --- 4) Sweep expired Kiro artifacts outside the repo ------------------------
#
# Runs right after the update check on purpose: the updater has just extracted the current
# kas tree (~505MB per release), so this is the moment the superseded ones become dead
# weight. Nothing else ever expires them -- neither the IDE nor kiro-cli prunes its own
# caches, and they all live outside the repo where TEMP redirection cannot reach them.
#
# Defaults are conservative and read-only for anything valuable: per-workspace IDE agent
# state (chat history + revert checkpoints) is left untouched unless the operator passes
# -AgentStateIdleDays explicitly. Never fatal: a failed sweep must not block startup.
$sweepScript = Join-Path $repo "scripts\sweep-kiro-artifacts.ps1"
if (Test-Path -LiteralPath $sweepScript -PathType Leaf) {
    Write-Step "Sweeping expired Kiro artifacts"
    try {
        & powershell -NoProfile -ExecutionPolicy Bypass -File $sweepScript -Quiet
    } catch {
        Write-Warn "Kiro artifact sweep failed: $($_.Exception.Message)"
    }
}

# --- 5) Start Clowder (default mode = Redis; trust-all is automatic) ---------
$startArgs = @("start")
if ($Dev) { $startArgs += "--dev" }
if ($Debug) { $startArgs += "--debug" }
if ($Quick) { $startArgs += "--quick" }
$modeLabel = if ($Dev) { "DEV (hot reload)" } else { "production" }
Write-Step "Starting Clowder (API + web, $modeLabel) ..."
& node (Join-Path $repo "scripts\start-entry.mjs") @startArgs
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}
