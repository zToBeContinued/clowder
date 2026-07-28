<#
.SYNOPSIS
  Clowder AI (Cat Cafe) - Windows Stop Script

.DESCRIPTION
  Stops Cat Cafe services (API, Frontend, Redis) by port.

.EXAMPLE
  .\scripts\stop-windows.ps1
#>

$ErrorActionPreference = "Continue"

function Write-Ok   { param([string]$msg) Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn { param([string]$msg) Write-Host "  [!!] $msg" -ForegroundColor Yellow }

$ScriptPath = if ($PSCommandPath) { $PSCommandPath } elseif ($MyInvocation.MyCommand.Path) { $MyInvocation.MyCommand.Path } else { $null }
$ScriptDir = if ($ScriptPath) { Split-Path -Parent $ScriptPath } else { $null }
if ($ScriptDir) {
    . (Join-Path $ScriptDir "install-windows-helpers.ps1")
}
$ProjectRoot = if ($ScriptDir) { Split-Path -Parent $ScriptDir } else { $null }
$RunDir = if ($ProjectRoot) { Join-Path $ProjectRoot ".cat-cafe/run/windows" } else { $null }

Write-Host "Cat Cafe - Stopping services" -ForegroundColor Cyan
Write-Host "============================="

# Load .env for port config
$envFile = Join-Path (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) ".env"
$ApiPort = 3004
$WebPort = 3003
$RedisPort = 6399

if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith("#")) {
            $parts = $line -split "=", 2
            if ($parts.Count -eq 2) {
                $key = $parts[0].Trim()
                $val = $parts[1].Trim().Trim('"').Trim("'")
                switch ($key) {
                    "API_SERVER_PORT" { $ApiPort = [int]$val }
                    "FRONTEND_PORT"   { $WebPort = [int]$val }
                    "REDIS_PORT"      { $RedisPort = [int]$val }
                }
            }
        }
    }
}

$configuredRedisUrl = Get-InstallerEnvValueFromFile -EnvFile $envFile -Key "REDIS_URL"
if (-not $configuredRedisUrl -and $env:REDIS_URL) {
    $configuredRedisUrl = $env:REDIS_URL.Trim()
}

function Get-ManagedProcessId {
    param([string]$ManagedPidFile)
    if (-not $ManagedPidFile -or -not (Test-Path $ManagedPidFile)) {
        return $null
    }
    try {
        return [int](Get-Content $ManagedPidFile -TotalCount 1).Trim()
    } catch {
        return $null
    }
}

function Get-ProcessCommandLine {
    param([int]$ProcessId)
    try {
        $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
        return $processInfo.CommandLine
    } catch {
        return $null
    }
}

function Test-ClowderOwnedProcess {
    param([int]$ProcessId, [string]$ClowderProjectRoot)
    if (-not $ClowderProjectRoot) {
        return $false
    }
    $commandLine = Get-ProcessCommandLine -ProcessId $ProcessId
    if (-not $commandLine) {
        return $false
    }
    $normalizedRoot = $ClowderProjectRoot.TrimEnd('\', '/') + '\'
    return ($commandLine -like "*$normalizedRoot*") -or ($commandLine -like "*$ClowderProjectRoot`"*") -or ($commandLine -like "*$ClowderProjectRoot'*")
}

# Best-effort graceful stop: deliver a real console Ctrl+C so Node runs its
# SIGINT handler (Fastify onClose -> acpPoolRegistry.closeAll() -> ACP carriers killed).
#
# Why this is needed: Stop-Process -Force is TerminateProcess. On Windows that does NOT
# run Node's signal handlers, so the whole graceful shutdown chain is skipped and the
# spawned ACP carriers (kiro-cli, gemini, ...) are orphaned -- they keep running and hold
# Kiro's per-session lock, which later surfaces as
# "Session is active in another process (PID ...)".
#
# GenerateConsoleCtrlEvent requires attaching to the target's console, and AttachConsole
# would hijack ours -- so this runs in an isolated child PowerShell whose console state
# we do not care about. Any failure just falls through to the force path.
function Invoke-GracefulConsoleStop {
    param([int]$ProcessId, [int]$TimeoutSeconds = 8)

    $helper = @'
param([int]$TargetPid)
Add-Type -Namespace W -Name K -MemberDefinition @"
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint dwProcessId);
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole();
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetConsoleCtrlHandler(IntPtr h, bool add);
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool GenerateConsoleCtrlEvent(uint dwCtrlEvent, uint dwProcessGroupId);
"@
[void][W.K]::FreeConsole()
if ([W.K]::AttachConsole([uint32]$TargetPid)) {
    [void][W.K]::SetConsoleCtrlHandler([IntPtr]::Zero, $true)
    [void][W.K]::GenerateConsoleCtrlEvent(0, 0)
    Start-Sleep -Milliseconds 200
    [void][W.K]::FreeConsole()
    exit 0
}
exit 1
'@

    $helperPath = Join-Path ([System.IO.Path]::GetTempPath()) "clowder-ctrlc-$ProcessId.ps1"
    try {
        Set-Content -LiteralPath $helperPath -Value $helper -Encoding ASCII
        Start-Process -FilePath "powershell.exe" `
            -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $helperPath, '-TargetPid', $ProcessId) `
            -WindowStyle Hidden -Wait -ErrorAction Stop | Out-Null
    } catch {
        return $false
    } finally {
        Remove-Item -LiteralPath $helperPath -Force -ErrorAction SilentlyContinue
    }

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) { return $true }
        Start-Sleep -Milliseconds 250
    }
    return $false
}

# Reap ACP carrier processes recorded by the API (.cat-cafe/run/acp-children/*.json).
#
# This is the deterministic guarantee: even when the graceful path above fails, a normal
# `stop` must not leave carriers behind. Mirrors the API's own boot-time sweep.
#
# PID reuse is the hazard here -- a stale pid may already belong to an unrelated process.
# So a record is only acted on when the live process's creation time is within tolerance of
# the recorded spawn time AND the image name matches. Otherwise: drop the record, kill nothing.
function Stop-AcpCarriers {
    param([string]$ClowderProjectRoot)
    if (-not $ClowderProjectRoot) { return }
    $registryDir = Join-Path $ClowderProjectRoot ".cat-cafe/run/acp-children"
    if (-not (Test-Path -LiteralPath $registryDir)) { return }

    $toleranceMs = 60000
    $records = @(Get-ChildItem -LiteralPath $registryDir -Filter "*.json" -File -ErrorAction SilentlyContinue)
    if ($records.Count -eq 0) { return }

    $reaped = 0
    $skipped = 0
    foreach ($file in $records) {
        $record = $null
        try { $record = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json } catch { $record = $null }
        if (-not $record -or -not $record.pid) {
            Remove-Item -LiteralPath $file.FullName -Force -ErrorAction SilentlyContinue
            continue
        }

        $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($record.pid)" -ErrorAction SilentlyContinue
        if ($proc) {
            $epoch = [datetime]::SpecifyKind([datetime]"1970-01-01", "Utc")
            $startedAtMs = [long]($proc.CreationDate.ToUniversalTime() - $epoch).TotalMilliseconds
            $drift = [Math]::Abs($startedAtMs - [long]$record.spawnedAtMs)
            $expected = [System.IO.Path]::GetFileNameWithoutExtension([string]$record.command)
            $actualImage = if ($proc.ExecutablePath) { $proc.ExecutablePath } else { $proc.Name }
            $actual = [System.IO.Path]::GetFileNameWithoutExtension($actualImage)

            if ($drift -le $toleranceMs -and $expected -ieq $actual) {
                Stop-Process -Id $record.pid -Force -ErrorAction SilentlyContinue
                $reaped++
            } else {
                Write-Warn "Skipping PID $($record.pid): identity mismatch (likely PID reuse; expected '$expected', found '$actual')"
                $skipped++
            }
        }
        Remove-Item -LiteralPath $file.FullName -Force -ErrorAction SilentlyContinue
    }

    if ($reaped -gt 0) { Write-Ok "Reaped $reaped ACP carrier process(es)" }
    if ($skipped -gt 0) { Write-Warn "$skipped carrier record(s) skipped for safety" }
}

function Stop-PortProcess {
    param([int]$Port, [string]$Name, [string]$PidFile, [string]$ProjectRoot, [switch]$Graceful)
    $connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($connections) {
        $managedPid = Get-ManagedProcessId -ManagedPidFile $PidFile
        $stopped = $false
        foreach ($conn in $connections) {
            $isManagedPid = $managedPid -and ($conn.OwningProcess -eq $managedPid)
            $isClowderOwned = $isManagedPid -or (Test-ClowderOwnedProcess -ProcessId $conn.OwningProcess -ClowderProjectRoot $ProjectRoot)
            if (-not $isClowderOwned) {
                Write-Warn "Skipping non-Clowder $Name listener on port $Port (PID $($conn.OwningProcess))"
                continue
            }
            # Graceful first so the API can tear down its ACP carriers itself; force is the fallback.
            if ($Graceful -and (Invoke-GracefulConsoleStop -ProcessId $conn.OwningProcess)) {
                Write-Ok "$Name stopped gracefully (PID $($conn.OwningProcess))"
                $stopped = $true
                continue
            }
            Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
            $stopped = $true
        }
        if ($stopped) {
            Remove-Item $PidFile -ErrorAction SilentlyContinue
            Write-Ok "Stopped $Name (port $Port)"
        } else {
            Write-Warn "$Name (port $Port) - no Clowder-owned listener found"
        }
    } else {
        Write-Warn "$Name (port $Port) - not running"
    }
}

$ApiPidFile = if ($RunDir) { Join-Path $RunDir "api-$ApiPort.pid" } else { $null }
$WebPidFile = if ($RunDir) { Join-Path $RunDir "web-$WebPort.pid" } else { $null }

Stop-PortProcess -Port $ApiPort -Name "API Server" -PidFile $ApiPidFile -ProjectRoot $ProjectRoot -Graceful
Stop-PortProcess -Port $WebPort -Name "Frontend" -PidFile $WebPidFile -ProjectRoot $ProjectRoot

# Safety net: whatever happened above (graceful, forced, or already dead), no ACP carrier
# may survive a normal stop. Runs unconditionally -- it also cleans up carriers orphaned by
# an earlier window-close, which never got a chance to run any shutdown path at all.
Stop-AcpCarriers -ClowderProjectRoot $ProjectRoot

# Stop Redis if running on our managed port.
# Only shut down Redis when:
# 1. No external REDIS_URL is configured (we manage the instance), OR
# 2. REDIS_URL points to our managed port (localhost:$RedisPort)
$redisLayout = if ($ProjectRoot) { Resolve-PortableRedisLayout -ProjectRoot $ProjectRoot } else { $null }
$redisPidFile = if ($redisLayout) { Join-Path $redisLayout.Data "redis-$RedisPort.pid" } else { $null }

if ($configuredRedisUrl -and -not (Test-LocalRedisUrl -RedisUrl $configuredRedisUrl -RedisPort $RedisPort)) {
    Write-Warn "Skipping local Redis shutdown because REDIS_URL points to an external host"
} else {
    try {
        $redisConnections = Get-NetTCPConnection -LocalPort $RedisPort -State Listen -ErrorAction SilentlyContinue
        if (-not $redisConnections) {
            Write-Warn "Redis (port $RedisPort) - not running"
        } else {
            $managedRedisPid = Get-ManagedProcessId -ManagedPidFile $redisPidFile
            $ownedRedisConnections = @()
            foreach ($conn in $redisConnections) {
                $isManagedPid = $managedRedisPid -and ($conn.OwningProcess -eq $managedRedisPid)
                $isClowderOwned = $isManagedPid -or (Test-ClowderOwnedProcess -ProcessId $conn.OwningProcess -ClowderProjectRoot $ProjectRoot)
                if (-not $isClowderOwned) {
                    Write-Warn "Skipping non-Clowder Redis listener on port $RedisPort (PID $($conn.OwningProcess))"
                    continue
                }
                $ownedRedisConnections += $conn
            }
            if ($ownedRedisConnections.Count -eq 0) {
                Write-Warn "Redis (port $RedisPort) - no Clowder-owned listener found"
            } else {
                $shutdownUrl = if ($configuredRedisUrl) { $configuredRedisUrl } else { "redis://localhost:$RedisPort" }
                if (Test-RedisReachable -RedisUrl $shutdownUrl) {
                    Send-RedisShutdown -RedisUrl $shutdownUrl
                    Write-Ok "Redis stopped (port $RedisPort)"
                } else {
                    Write-Warn "Redis (port $RedisPort) - not running"
                }
            }
        }
    } catch {
        Write-Warn "Redis (port $RedisPort) - not running"
    }
}

Write-Host "`nAll services stopped." -ForegroundColor Green
