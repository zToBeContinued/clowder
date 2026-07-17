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
    }
}
