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
    # kiro-cli downloads a full installer to %TEMP%\kiro-installer-<uuid>.msi on every cold
    # start of `acp` -- ~238MB each -- and never removes it. This is kiro-cli's own behaviour:
    # the app.disableAutoupdates setting does NOT stop it (verified with an isolated TEMP and
    # a fresh process), and the binary exposes no environment switch to opt out. Measured:
    # 28 files / 5.33GB in .cat-cafe/runtime/tmp over ~8 hours, ~half of them partial
    # fragments left behind when the process was evicted mid-download. The extracted kas
    # component never changed, so every one of these downloads was pure waste.
    #
    # No age cutoff on purpose: the pile grows within a single working day, so anything
    # older than one day is far too late. This is safe because Windows locks a file that is
    # actively being downloaded, Remove-Item then fails and -ErrorAction SilentlyContinue
    # skips it -- an in-flight download is never interrupted, and startup is never blocked.
    # The pattern stays deliberately narrow: only files we positively recognize.
    #
    # Keep this file ASCII-only: it has no BOM, and Windows PowerShell 5.1 decodes .ps1 with
    # the ANSI codepage, which corrupts non-ASCII bytes and can swallow line breaks.
    $staleTempRemoved = 0
    foreach ($pattern in @("kiro-installer-*.msi")) {
        $candidates = @(Get-ChildItem -LiteralPath $tempRoot -Filter $pattern -File -Force -ErrorAction SilentlyContinue)
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
