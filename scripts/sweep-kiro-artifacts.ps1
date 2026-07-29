<#
.SYNOPSIS
    Reclaim disk from Kiro IDE / kiro-cli artifacts that nothing cleans up.

.DESCRIPTION
    Kiro writes several unbounded caches outside the repo, and neither the IDE nor the
    CLI expires them:

      1. %LOCALAPPDATA%\Kiro-Cli\kas\<version>-<sha>\  ~505MB per release. The updater
         extracts a new tree on every version bump and keeps every old one forever.
      2. %USERPROFILE%\.kiro\sessions\cli\*.jsonl      one file per `kiro-cli` session.
         Clowder spawns an ACP carrier per cat, so this grows with every chat.
      3. %APPDATA%\Kiro\logs\<timestamp>\              one dir per IDE launch, holds
         LLM prompt/completion dumps (tens of MB each).
      4. %APPDATA%\Kiro\User\History\                  IDE local file edit history.
      5. %APPDATA%\Kiro\Crashpad\                      crash dumps, never pruned.
      6. One-shot probe leftovers (%USERPROFILE%\kiro-dl-probe, stray %TEMP%\kiro-log).

    Every target is matched positively -- no wildcard sweeps of parent directories.
    Locked files (the IDE and ACP carriers are normally running) are skipped instead of
    failing the run.

    The agent-state purge (-AgentStateIdleDays) is opt-in and OFF by default: it deletes
    a workspace's entire Kiro IDE conversation history and its revert checkpoints.

.PARAMETER DryRun
    Report what would be removed and exit without deleting anything.

.PARAMETER KeepKasVersions
    How many newest kas trees to keep. Default 1. The running kiro-cli only ever loads
    the newest tree, but keeping one extra costs ~505MB if you want a rollback path.

.PARAMETER CliSessionDays
    Delete kiro-cli session transcripts older than this. Default 7. Only affects
    `kiro-cli --resume` for conversations that old. Clowder spawns one ACP carrier per
    cat, so this is the fastest growing target: 122MB accumulated over two weeks.

.PARAMETER KeepIdeLogSessions
    How many newest IDE launch log directories to keep. Default 5.

.PARAMETER IdeHistoryDays
    Delete IDE local file edit history older than this. Default 30. Git already covers
    committed work; this is the editor's own undo store.

.PARAMETER AgentStateIdleDays
    DESTRUCTIVE, opt-in. Delete per-workspace Kiro IDE agent state (chat executions and
    file checkpoints) for workspaces with no activity for this many days. 0 disables.

.PARAMETER Quiet
    Print a single summary line instead of the per-target breakdown. Used by
    start-clowder.ps1 so the sweep does not bury the launcher output.

.NOTES
    Keep this file ASCII-only and BOM-less: Windows PowerShell 5.1 decodes .ps1 with the
    ANSI codepage, which corrupts non-ASCII bytes and can swallow line breaks. Same
    constraint as scripts/windows-runtime-env.ps1.
#>
[CmdletBinding()]
param(
    [switch]$DryRun,
    [int]$KeepKasVersions = 1,
    [int]$CliSessionDays = 7,
    [int]$KeepIdeLogSessions = 5,
    [int]$IdeHistoryDays = 30,
    [int]$AgentStateIdleDays = 0,
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

$script:Planned = 0L
$script:Removed = 0L
$script:Skipped = 0L
$script:Rows = @()

function Get-PathSize {
    param([string]$Path)
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    if (-not $item) { return 0L }
    if (-not $item.PSIsContainer) { return [long]$item.Length }
    $measured = Get-ChildItem -LiteralPath $Path -Recurse -Force -File -ErrorAction SilentlyContinue |
        Measure-Object -Property Length -Sum
    if ($measured.Sum) { return [long]$measured.Sum }
    return 0L
}

function Remove-Target {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Group,
        [string]$Note = ''
    )

    if (-not (Test-Path -LiteralPath $Path)) { return }

    $size = Get-PathSize -Path $Path
    $script:Planned += $size

    if ($DryRun) {
        $script:Rows += [pscustomobject]@{
            Group = $Group; Bytes = $size; State = 'would-remove'; Path = $Path; Note = $Note
        }
        return
    }

    Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue

    if (Test-Path -LiteralPath $Path) {
        # Still there: something holds a handle (running IDE / ACP carrier). Count what
        # actually went away so the totals stay honest.
        $left = Get-PathSize -Path $Path
        $script:Removed += ($size - $left)
        $script:Skipped += $left
        $script:Rows += [pscustomobject]@{
            Group = $Group; Bytes = $size; State = 'partial (locked)'; Path = $Path; Note = $Note
        }
    }
    else {
        $script:Removed += $size
        $script:Rows += [pscustomobject]@{
            Group = $Group; Bytes = $size; State = 'removed'; Path = $Path; Note = $Note
        }
    }
}

function Get-UserHome {
    if ($env:USERPROFILE) { return $env:USERPROFILE }
    return [Environment]::GetFolderPath('UserProfile')
}

$userHome = Get-UserHome
$roamingKiro = Join-Path $env:APPDATA 'Kiro'
$kiroCliRoot = Join-Path $env:LOCALAPPDATA 'Kiro-Cli'
$dotKiro = Join-Path $userHome '.kiro'
$cutoffLabel = @()

if (-not $Quiet) {
    Write-Host ''
    Write-Host ('Kiro artifact sweep' + $(if ($DryRun) { ' (DRY RUN)' } else { '' })) -ForegroundColor Cyan
    Write-Host ''
}

# --- 1) Stale kas trees -------------------------------------------------------------
# The version is the leading path segment, so newest-by-name is wrong (2.9 > 2.14
# lexically). Sort by write time instead: the updater touches a tree when it extracts it.
$kasRoot = Join-Path $kiroCliRoot 'kas'
if (Test-Path -LiteralPath $kasRoot) {
    $kasDirs = @(Get-ChildItem -LiteralPath $kasRoot -Directory -Force -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending)
    if ($kasDirs.Count -gt $KeepKasVersions) {
        foreach ($stale in $kasDirs[$KeepKasVersions..($kasDirs.Count - 1)]) {
            Remove-Target -Path $stale.FullName -Group 'kas' -Note $stale.LastWriteTime.ToString('yyyy-MM-dd')
            $lock = "$($stale.FullName).lock"
            Remove-Target -Path $lock -Group 'kas' -Note 'lock file'
        }
    }
    $cutoffLabel += "kas: keep newest $KeepKasVersions of $($kasDirs.Count)"
}

# --- 2) kiro-cli session transcripts ------------------------------------------------
# One session is a set of sibling files sharing a UUID basename: <id>.jsonl (transcript),
# <id>.json (metadata), <id>.history, <id>.lock. Group by basename and expire the whole
# set, otherwise deleting only the transcript leaves orphaned metadata behind. Grouping
# also cleans up sets whose transcript is already gone.
$cliSessions = Join-Path $dotKiro 'sessions\cli'
if ((Test-Path -LiteralPath $cliSessions) -and $CliSessionDays -gt 0) {
    $cutoff = (Get-Date).AddDays(-$CliSessionDays)
    $sets = Get-ChildItem -LiteralPath $cliSessions -File -Force -ErrorAction SilentlyContinue |
        Group-Object { [System.IO.Path]::GetFileNameWithoutExtension($_.Name) }
    $expired = 0
    foreach ($set in $sets) {
        # A session is only expired when every file in the set is past the cutoff, so an
        # active session that reuses an old id is never truncated mid-write.
        $newest = ($set.Group | Sort-Object LastWriteTime -Descending | Select-Object -First 1)
        if ($newest.LastWriteTime -ge $cutoff) { continue }
        foreach ($f in $set.Group) {
            Remove-Target -Path $f.FullName -Group 'cli-sessions' -Note $newest.LastWriteTime.ToString('yyyy-MM-dd')
        }
        $expired++
    }
    $cutoffLabel += "cli sessions: sets older than $CliSessionDays days ($expired of $($sets.Count) sets)"
}

# --- 3) IDE launch logs -------------------------------------------------------------
$ideLogs = Join-Path $roamingKiro 'logs'
if (Test-Path -LiteralPath $ideLogs) {
    $logDirs = @(Get-ChildItem -LiteralPath $ideLogs -Directory -Force -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending)
    if ($logDirs.Count -gt $KeepIdeLogSessions) {
        foreach ($stale in $logDirs[$KeepIdeLogSessions..($logDirs.Count - 1)]) {
            Remove-Target -Path $stale.FullName -Group 'ide-logs' -Note $stale.Name
        }
    }
    $cutoffLabel += "ide logs: keep newest $KeepIdeLogSessions of $($logDirs.Count)"
}

# --- 4) IDE local edit history ------------------------------------------------------
# Each entry is a directory holding numbered revisions plus entries.json. Drop the whole
# entry only when every revision in it is past the cutoff, so a file edited today keeps
# its full undo chain.
$ideHistory = Join-Path $roamingKiro 'User\History'
if ((Test-Path -LiteralPath $ideHistory) -and $IdeHistoryDays -gt 0) {
    $cutoff = (Get-Date).AddDays(-$IdeHistoryDays)
    $stale = 0
    foreach ($entry in @(Get-ChildItem -LiteralPath $ideHistory -Directory -Force -ErrorAction SilentlyContinue)) {
        $newest = Get-ChildItem -LiteralPath $entry.FullName -File -Force -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($newest -and $newest.LastWriteTime -lt $cutoff) {
            Remove-Target -Path $entry.FullName -Group 'ide-history' -Note $newest.LastWriteTime.ToString('yyyy-MM-dd')
            $stale++
        }
    }
    $cutoffLabel += "ide history: entries untouched for $IdeHistoryDays days ($stale entries)"
}

# --- 5) Crash dumps ----------------------------------------------------------------
foreach ($sub in @('reports', 'new', 'pending')) {
    $crashDir = Join-Path $roamingKiro (Join-Path 'Crashpad' $sub)
    if (Test-Path -LiteralPath $crashDir) {
        foreach ($dump in @(Get-ChildItem -LiteralPath $crashDir -File -Force -ErrorAction SilentlyContinue)) {
            Remove-Target -Path $dump.FullName -Group 'crashpad' -Note $sub
        }
    }
}

# --- 6) One-shot probe leftovers ---------------------------------------------------
# kiro-dl-probe is not referenced anywhere in this repo -- it is residue from a manual
# download investigation that pointed TEMP at the user profile.
Remove-Target -Path (Join-Path $userHome 'kiro-dl-probe') -Group 'probe-residue' -Note 'manual download probe'
# kiro-cli writes %TEMP%\kiro-log. Clowder redirects TEMP into the repo, so anything in
# the system temp came from a launch that bypassed start-clowder.ps1.
Remove-Target -Path (Join-Path $env:LOCALAPPDATA 'Temp\kiro-log') -Group 'probe-residue' -Note 'non-Clowder launch'

# --- 7) Per-workspace IDE agent state (opt-in, destructive) ------------------------
if ($AgentStateIdleDays -gt 0) {
    $agentState = Join-Path $roamingKiro 'User\globalStorage\kiro.kiroagent'
    if (Test-Path -LiteralPath $agentState) {
        $cutoff = (Get-Date).AddDays(-$AgentStateIdleDays)
        # Workspace buckets are 32-char hex hashes; skip the named siblings
        # (workspace-sessions, dev_data, sessions, default, .diffs).
        foreach ($bucket in @(Get-ChildItem -LiteralPath $agentState -Directory -Force -ErrorAction SilentlyContinue |
                    Where-Object { $_.Name -match '^[0-9a-f]{32}$' })) {
            $newest = Get-ChildItem -LiteralPath $bucket.FullName -Recurse -Force -File -ErrorAction SilentlyContinue |
                Sort-Object LastWriteTime -Descending | Select-Object -First 1
            if ($newest -and $newest.LastWriteTime -lt $cutoff) {
                Remove-Target -Path $bucket.FullName -Group 'agent-state' -Note ('idle since ' + $newest.LastWriteTime.ToString('yyyy-MM-dd'))
            }
        }
        $cutoffLabel += "agent state: workspaces idle for $AgentStateIdleDays days"
    }
}

# --- Report -------------------------------------------------------------------------
if ($Quiet) {
    $reclaimed = if ($DryRun) { $script:Planned } else { $script:Removed }
    $verb = if ($DryRun) { 'reclaimable' } else { 'reclaimed' }
    if ($script:Rows.Count -eq 0) {
        Write-Host '  [OK] Kiro artifacts: nothing expired' -ForegroundColor Green
    }
    else {
        $groups = ($script:Rows | Group-Object Group | ForEach-Object { $_.Name }) -join ', '
        Write-Host ('  [OK] Kiro artifacts {0} {1:N0} MB ({2})' -f $verb, ($reclaimed / 1MB), $groups) -ForegroundColor Green
    }
    return
}

foreach ($label in $cutoffLabel) { Write-Host ('  policy: ' + $label) -ForegroundColor DarkGray }
Write-Host ''

if ($script:Rows.Count -eq 0) {
    Write-Host '  nothing to reclaim' -ForegroundColor Green
}
else {
    $script:Rows | Group-Object Group | Sort-Object { ($_.Group | Measure-Object Bytes -Sum).Sum } -Descending | ForEach-Object {
        $groupBytes = ($_.Group | Measure-Object Bytes -Sum).Sum
        Write-Host ('  {0,-16} {1,9:N1} MB  {2} item(s)' -f $_.Name, ($groupBytes / 1MB), $_.Count) -ForegroundColor Yellow
        $_.Group | Sort-Object Bytes -Descending | Select-Object -First 6 | ForEach-Object {
            $shown = $_.Path
            if ($shown.Length -gt 96) { $shown = '...' + $shown.Substring($shown.Length - 93) }
            Write-Host ('      {0,8:N1} MB  {1,-16} {2}  {3}' -f ($_.Bytes / 1MB), $_.State, $shown, $_.Note) -ForegroundColor DarkGray
        }
        if ($_.Count -gt 6) { Write-Host ('      ... and {0} more' -f ($_.Count - 6)) -ForegroundColor DarkGray }
    }
}

Write-Host ''
if ($DryRun) {
    Write-Host ('  reclaimable: {0:N1} MB' -f ($script:Planned / 1MB)) -ForegroundColor Cyan
    Write-Host '  (dry run -- nothing was deleted)' -ForegroundColor DarkGray
}
else {
    Write-Host ('  reclaimed: {0:N1} MB' -f ($script:Removed / 1MB)) -ForegroundColor Green
    if ($script:Skipped -gt 0) {
        Write-Host ('  skipped (locked by a running process): {0:N1} MB' -f ($script:Skipped / 1MB)) -ForegroundColor Yellow
    }
}
Write-Host ''
