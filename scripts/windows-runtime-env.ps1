function Initialize-ClowderWindowsRuntimeEnvironment {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$ProjectRoot
    )

    if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
        throw "ProjectRoot must not be empty"
    }

    $resolvedProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
    $stateRoot = Join-Path $resolvedProjectRoot ".cat-cafe"
    $runtimeRoot = Join-Path $stateRoot "runtime"
    $tempRoot = Join-Path $runtimeRoot "tmp"
    $npmCache = Join-Path $runtimeRoot "npm-cache"
    $pnpmStore = Join-Path $stateRoot "pnpm-store"

    foreach ($directory in @($tempRoot, $npmCache, $pnpmStore)) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }

    # Sweep known download leftovers.
    #
    # Once TEMP is redirected into the repo, Windows never cleans it for us again.
    # kiro-cli's self-updater (setting: app.disableAutoupdates, on by default) downloads the
    # full installer to %TEMP%\kiro-installer-<uuid>.msi -- ~238MB each -- and the install
    # step never lands inside a long-lived `acp` process. Observed: 16 files / 3.38GB piled
    # up in .cat-cafe/runtime/tmp over a single morning.
    #
    # Deliberately narrow: only files we positively recognize AND older than one day, so
    # temp files still in use are never touched. A locked file is skipped silently -- this
    # must never block startup.
    #
    # Keep this file ASCII-only: it has no BOM, and Windows PowerShell 5.1 decodes .ps1 with
    # the ANSI codepage, which corrupts non-ASCII bytes and can swallow line breaks.
    $staleTempCutoff = (Get-Date).AddDays(-1)
    $staleTempRemoved = 0
    foreach ($pattern in @("kiro-installer-*.msi")) {
        $candidates = @(Get-ChildItem -LiteralPath $tempRoot -Filter $pattern -File -Force -ErrorAction SilentlyContinue |
            Where-Object { $_.LastWriteTime -lt $staleTempCutoff })
        foreach ($candidate in $candidates) {
            Remove-Item -LiteralPath $candidate.FullName -Force -ErrorAction SilentlyContinue
            if (-not (Test-Path -LiteralPath $candidate.FullName)) {
                $staleTempRemoved++
            }
        }
    }

    foreach ($name in @("TEMP", "TMP", "TMPDIR")) {
        [System.Environment]::SetEnvironmentVariable($name, $tempRoot, "Process")
    }
    [System.Environment]::SetEnvironmentVariable("npm_config_cache", $npmCache, "Process")
    [System.Environment]::SetEnvironmentVariable("pnpm_config_store_dir", $pnpmStore, "Process")

    return [pscustomobject]@{
        ProjectRoot = $resolvedProjectRoot
        StateRoot = $stateRoot
        TempRoot = $tempRoot
        NpmCache = $npmCache
        PnpmStore = $pnpmStore
        StaleTempRemoved = $staleTempRemoved
    }
}
