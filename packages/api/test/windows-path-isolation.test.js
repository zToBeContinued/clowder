import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(TEST_DIR, '..');
const PROJECT_ROOT = resolve(API_ROOT, '../..');
const SANDBOX_ROOT = join(PROJECT_ROOT, '.cat-cafe', 'test-tmp');
const RUNTIME_HELPER = join(PROJECT_ROOT, 'scripts', 'windows-runtime-env.ps1');
const START_CMD = join(PROJECT_ROOT, 'start-clowder.cmd');
const START_PS1 = join(PROJECT_ROOT, 'start-clowder.ps1');
const START_BAT = join(PROJECT_ROOT, 'scripts', 'start.bat');
const START_WINDOWS_PS1 = join(PROJECT_ROOT, 'scripts', 'start-windows.ps1');
const INSTALL_PS1 = join(PROJECT_ROOT, 'scripts', 'install.ps1');
const REGISTRY_HELPER = join(TEST_DIR, 'helpers', 'setup-cat-registry.js');

function createSandbox(prefix) {
  mkdirSync(SANDBOX_ROOT, { recursive: true });
  return mkdtempSync(join(SANDBOX_ROOT, prefix));
}

function normalizedPath(value) {
  return resolve(value).replaceAll('\\', '/').toLowerCase();
}

function assertPathInside(value, parent, label) {
  const childPath = resolve(value);
  const parentPath = resolve(parent);
  const rel = relative(parentPath, childPath);
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel), `${label} must be inside ${parentPath}: ${childPath}`);
}

function parseJsonOutput(stdout) {
  return JSON.parse(stdout.trim().replace(/^\uFEFF/, ''));
}

test(
  'Windows runtime helper is cwd-independent and keeps temp/cache/store inside the project',
  { skip: process.platform !== 'win32' },
  () => {
    const sandbox = createSandbox('runtime-helper-');
    try {
      const projectRoot = join(sandbox, 'temporary project');
      const scriptsDir = join(projectRoot, 'scripts');
      const unrelatedCwd = join(sandbox, 'unrelated cwd');
      mkdirSync(scriptsDir, { recursive: true });
      mkdirSync(unrelatedCwd, { recursive: true });
      const helperCopy = join(scriptsDir, 'windows-runtime-env.ps1');
      copyFileSync(RUNTIME_HELPER, helperCopy);

      const driver = join(sandbox, 'invoke-helper.ps1');
      writeFileSync(
        driver,
        `param(
    [string]$HelperPath,
    [string]$ProjectRoot,
    [string]$WorkingDirectory
)
Set-Location -LiteralPath $WorkingDirectory
$env:PNPM_HOME = "sentinel-pnpm-home"
. $HelperPath
$runtime = Initialize-ClowderWindowsRuntimeEnvironment -ProjectRoot $ProjectRoot
$resolvedPnpmStore = (& pnpm store path | Select-Object -Last 1).Trim()
[ordered]@{
    Cwd = (Get-Location).Path
    Temp = $env:TEMP
    Tmp = $env:TMP
    TmpDir = $env:TMPDIR
    NpmCache = [System.Environment]::GetEnvironmentVariable("npm_config_cache", "Process")
    PnpmStore = [System.Environment]::GetEnvironmentVariable("pnpm_config_store_dir", "Process")
    ResolvedPnpmStore = $resolvedPnpmStore
    PnpmHome = $env:PNPM_HOME
    Runtime = $runtime
} | ConvertTo-Json -Depth 4 -Compress
`,
        'utf8',
      );

      const result = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          driver,
          '-HelperPath',
          helperCopy,
          '-ProjectRoot',
          projectRoot,
          '-WorkingDirectory',
          unrelatedCwd,
        ],
        { encoding: 'utf8', windowsHide: true },
      );
      assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

      const actual = parseJsonOutput(result.stdout);
      const expectedTemp = join(projectRoot, '.cat-cafe', 'runtime', 'tmp');
      const expectedCache = join(projectRoot, '.cat-cafe', 'runtime', 'npm-cache');
      const expectedStore = join(projectRoot, '.cat-cafe', 'pnpm-store');

      assert.equal(normalizedPath(actual.Cwd), normalizedPath(unrelatedCwd));
      assert.equal(normalizedPath(actual.Temp), normalizedPath(expectedTemp));
      assert.equal(normalizedPath(actual.Tmp), normalizedPath(expectedTemp));
      assert.equal(normalizedPath(actual.TmpDir), normalizedPath(expectedTemp));
      assert.equal(normalizedPath(actual.NpmCache), normalizedPath(expectedCache));
      assert.equal(normalizedPath(actual.PnpmStore), normalizedPath(expectedStore));
      assertPathInside(actual.ResolvedPnpmStore, expectedStore, 'resolved pnpm store');
      assert.equal(actual.PnpmHome, 'sentinel-pnpm-home');
      assert.equal(normalizedPath(actual.Runtime.ProjectRoot), normalizedPath(projectRoot));

      for (const [label, directory] of [
        ['TEMP', actual.Temp],
        ['TMP', actual.Tmp],
        ['TMPDIR', actual.TmpDir],
        ['npm cache', actual.NpmCache],
        ['pnpm store', actual.PnpmStore],
      ]) {
        assertPathInside(directory, projectRoot, label);
        assert.equal(existsSync(directory), true, `${label} directory must exist`);
      }
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  },
);

test(
  'Windows project pnpm configuration keeps store commands inside the workspace',
  { skip: process.platform !== 'win32' },
  () => {
    const sandbox = createSandbox('pnpm-store-config-');
    try {
      const projectRoot = join(sandbox, 'temporary project');
      const packageCwd = join(projectRoot, 'packages', 'api');
      const driver = join(sandbox, 'resolve-pnpm-store.ps1');
      mkdirSync(packageCwd, { recursive: true });

      const rootPackage = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8'));
      assert.equal(typeof rootPackage.packageManager, 'string');
      writeFileSync(
        join(projectRoot, 'package.json'),
        `${JSON.stringify(
          {
            name: 'pnpm-store-isolation-probe',
            private: true,
            packageManager: rootPackage.packageManager,
          },
          null,
          2,
        )}\n`,
        'utf8',
      );
      writeFileSync(join(packageCwd, 'package.json'), '{"name":"@probe/api","private":true}\n', 'utf8');
      copyFileSync(join(PROJECT_ROOT, '.npmrc'), join(projectRoot, '.npmrc'));
      copyFileSync(join(PROJECT_ROOT, 'pnpm-workspace.yaml'), join(projectRoot, 'pnpm-workspace.yaml'));
      writeFileSync(
        driver,
        `$ErrorActionPreference = "Stop"
$output = & pnpm store path
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}
($output | Select-Object -Last 1).Trim()
`,
        'utf8',
      );

      const result = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', driver],
        {
          cwd: packageCwd,
          env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
          encoding: 'utf8',
          windowsHide: true,
        },
      );
      assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

      const resolvedStore = result.stdout.trim().replace(/^\uFEFF/, '');
      const expectedStoreBase = join(projectRoot, '.cat-cafe', 'pnpm-store');
      assertPathInside(resolvedStore, expectedStoreBase, 'resolved pnpm store');
      assert.doesNotMatch(normalizedPath(resolvedStore), /^[a-z]:\/\.pnpm-store(?:\/|$)/i);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  },
);

test('Windows launch entry points wire the shared runtime helper before dispatch', () => {
  const cmd = readFileSync(START_CMD, 'utf8');
  const ps1 = readFileSync(START_PS1, 'utf8');
  const startBat = readFileSync(START_BAT, 'utf8');
  const startWindows = readFileSync(START_WINDOWS_PS1, 'utf8');
  const install = readFileSync(INSTALL_PS1, 'utf8');
  const runtimeHelper = readFileSync(RUNTIME_HELPER, 'utf8');
  const npmrc = readFileSync(join(PROJECT_ROOT, '.npmrc'), 'utf8');

  assert.match(cmd, /^@echo off\r?\npushd "%~dp0" \|\| exit \/b 1/);
  assert.match(cmd, /endlocal & popd & exit \/b %clowder_exit_code%/);
  assert.match(startBat, /^@echo off\r?\npushd "%~dp0\.\." \|\| exit \/b 1/);
  assert.match(startBat, /endlocal & popd & exit \/b %clowder_exit_code%/);

  const setLocationIndex = ps1.indexOf('Set-Location -LiteralPath $repo');
  const runtimeInitIndex = ps1.indexOf('Initialize-ClowderWindowsRuntimeEnvironment -ProjectRoot $repo');
  const nodeDispatchIndex = ps1.indexOf('& node (Join-Path $repo "scripts\\start-entry.mjs") start');
  assert.ok(setLocationIndex >= 0 && setLocationIndex < runtimeInitIndex);
  assert.ok(runtimeInitIndex < nodeDispatchIndex);
  assert.doesNotMatch(ps1, /\bpnpm\s+(?:run\s+)?start\b/i);

  const directRuntimeIndex = startWindows.indexOf('Initialize-ClowderWindowsRuntimeEnvironment');
  assert.ok(directRuntimeIndex >= 0);
  assert.ok(directRuntimeIndex < startWindows.indexOf('$Profile_ ='));
  assert.ok(directRuntimeIndex < startWindows.indexOf('Resolve-ToolCommand -Name "pnpm"'));
  assert.match(install, /Initialize-ClowderWindowsRuntimeEnvironment -ProjectRoot \$ProjectRoot/);

  for (const variableName of ['TEMP', 'TMP', 'TMPDIR', 'npm_config_cache', 'pnpm_config_store_dir']) {
    assert.ok(runtimeHelper.includes(`"${variableName}"`), `runtime helper must set ${variableName}`);
  }
  assert.doesNotMatch(runtimeHelper, /\$env:PNPM_HOME\s*=|SetEnvironmentVariable\("PNPM_HOME"/i);
  assert.match(npmrc, /^store-dir=\.cat-cafe\/pnpm-store$/m);
});

test(
  'CMD launchers dispatch from the project directory and restore the caller cwd',
  { skip: process.platform !== 'win32' },
  async (t) => {
    for (const launchCase of [
      {
        name: 'start-clowder.cmd',
        source: START_CMD,
        relativeLauncher: 'start-clowder.cmd',
        relativeTarget: 'start-clowder.ps1',
      },
      {
        name: 'scripts/start.bat',
        source: START_BAT,
        relativeLauncher: join('scripts', 'start.bat'),
        relativeTarget: join('scripts', 'start-windows.ps1'),
      },
    ]) {
      await t.test(launchCase.name, () => {
        const sandbox = createSandbox('cmd-dispatch-');
        try {
          const projectRoot = join(sandbox, 'temporary project');
          const unrelatedCwd = join(sandbox, 'caller cwd');
          const launcher = join(projectRoot, launchCase.relativeLauncher);
          const target = join(projectRoot, launchCase.relativeTarget);
          const capture = join(sandbox, 'dispatch.txt');
          const returnCapture = join(sandbox, 'return-cwd.txt');
          mkdirSync(dirname(launcher), { recursive: true });
          mkdirSync(dirname(target), { recursive: true });
          mkdirSync(unrelatedCwd, { recursive: true });
          copyFileSync(launchCase.source, launcher);
          writeFileSync(
            target,
            '@((Get-Location).Path, $PSCommandPath) | Set-Content -LiteralPath $env:CLOWDER_DISPATCH_CAPTURE -Encoding UTF8\n',
            'ascii',
          );

          const env = { ...process.env, CLOWDER_DISPATCH_CAPTURE: capture };
          const cmdDriver = join(sandbox, 'invoke-launcher.cmd');
          writeFileSync(
            cmdDriver,
            `@echo off\r\ncd /d "${unrelatedCwd}"\r\ncall "${launcher}" <nul\r\ncd > "${returnCapture}"\r\nexit /b 0\r\n`,
            'ascii',
          );
          const result = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', cmdDriver], {
            cwd: unrelatedCwd,
            env,
            encoding: 'utf8',
            windowsHide: true,
          });
          assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

          const [dispatchCwd, dispatchedTarget] = readFileSync(capture, 'utf8')
            .trim()
            .replace(/^\uFEFF/, '')
            .split(/\r?\n/);
          const returnedCwd = readFileSync(returnCapture, 'utf8').trim();
          assert.equal(normalizedPath(dispatchCwd), normalizedPath(projectRoot));
          assert.equal(normalizedPath(dispatchedTarget), normalizedPath(target));
          assert.equal(normalizedPath(returnedCwd), normalizedPath(unrelatedCwd));
        } finally {
          rmSync(sandbox, { recursive: true, force: true });
        }
      });
    }
  },
);

test(
  'start-clowder.ps1 initializes local paths and dispatches directly to start-entry with node',
  { skip: process.platform !== 'win32' },
  () => {
    const sandbox = createSandbox('ps-dispatch-');
    try {
      const projectRoot = join(sandbox, 'temporary project');
      const scriptsDir = join(projectRoot, 'scripts');
      const unrelatedCwd = join(sandbox, 'caller cwd');
      const launcher = join(projectRoot, 'start-clowder.ps1');
      const capture = join(sandbox, 'node-dispatch.json');
      mkdirSync(scriptsDir, { recursive: true });
      mkdirSync(unrelatedCwd, { recursive: true });
      copyFileSync(START_PS1, launcher);
      copyFileSync(RUNTIME_HELPER, join(scriptsDir, 'windows-runtime-env.ps1'));
      writeFileSync(
        join(scriptsDir, 'install-windows-helpers.ps1'),
        'function Ensure-WindowsRedis { param([string]$ProjectRoot) return $true }\n',
        'ascii',
      );
      writeFileSync(join(scriptsDir, 'start-entry.mjs'), '// node dispatch target\n', 'utf8');

      const driver = join(sandbox, 'invoke-launcher.ps1');
      writeFileSync(
        driver,
        `param(
    [string]$Launcher,
    [string]$WorkingDirectory
)
$waitHandle = [pscustomobject]@{}
$waitHandle | Add-Member -MemberType ScriptMethod -Name WaitOne -Value { param($Timeout) return $false }
$global:ClowderMockAsyncResult = [pscustomobject]@{ AsyncWaitHandle = $waitHandle }
$global:ClowderMockTcpClient = [pscustomobject]@{ Connected = $false }
$global:ClowderMockTcpClient | Add-Member -MemberType ScriptMethod -Name BeginConnect -Value {
    param($HostName, $Port, $Callback, $State)
    return $global:ClowderMockAsyncResult
}
$global:ClowderMockTcpClient | Add-Member -MemberType ScriptMethod -Name Close -Value {}
function global:New-Object {
    param(
        [Parameter(Position = 0)]
        [string]$TypeName,
        [Parameter(ValueFromRemainingArguments = $true)]
        [object[]]$RemainingArguments
    )
    if ($TypeName -eq "System.Net.Sockets.TcpClient") {
        return $global:ClowderMockTcpClient
    }
    throw "Unexpected New-Object call: $TypeName"
}
function global:node {
    [ordered]@{
        Arguments = @($args | ForEach-Object { "$_" })
        Cwd = (Get-Location).Path
        Temp = $env:TEMP
        Tmp = $env:TMP
        TmpDir = $env:TMPDIR
        NpmCache = [System.Environment]::GetEnvironmentVariable("npm_config_cache", "Process")
        PnpmStore = [System.Environment]::GetEnvironmentVariable("pnpm_config_store_dir", "Process")
        PnpmHome = $env:PNPM_HOME
    } | ConvertTo-Json -Depth 3 -Compress | Set-Content -LiteralPath $env:CLOWDER_NODE_CAPTURE -Encoding UTF8
    $global:LASTEXITCODE = 0
}
$env:PNPM_HOME = "sentinel-pnpm-home"
Set-Location -LiteralPath $WorkingDirectory
& $Launcher
`,
        'utf8',
      );

      const result = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          driver,
          '-Launcher',
          launcher,
          '-WorkingDirectory',
          unrelatedCwd,
        ],
        {
          env: { ...process.env, CLOWDER_NODE_CAPTURE: capture },
          encoding: 'utf8',
          windowsHide: true,
        },
      );
      assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

      const actual = parseJsonOutput(readFileSync(capture, 'utf8'));
      assert.deepEqual(actual.Arguments.map(normalizedPath), [
        normalizedPath(join(projectRoot, 'scripts', 'start-entry.mjs')),
        normalizedPath('start'),
      ]);
      assert.equal(normalizedPath(actual.Cwd), normalizedPath(projectRoot));
      assert.equal(actual.PnpmHome, 'sentinel-pnpm-home');
      for (const [label, value] of [
        ['TEMP', actual.Temp],
        ['TMP', actual.Tmp],
        ['TMPDIR', actual.TmpDir],
        ['npm cache', actual.NpmCache],
        ['pnpm store', actual.PnpmStore],
      ]) {
        assertPathInside(value, projectRoot, label);
      }
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  },
);

test('registry setup uses os.tmpdir and removes only its process directory on exit', () => {
  const source = readFileSync(REGISTRY_HELPER, 'utf8');
  assert.match(source, /from 'node:os'/);
  assert.match(source, /mkdtempSync\(join\(tmpdir\(\)/);
  assert.match(source, /process\.once\('exit'/);
  assert.doesNotMatch(source, /TMPDIR\s*\?\?|['"]\/tmp['"]/);

  const sandbox = createSandbox('registry-cleanup-');
  try {
    const customTemp = join(sandbox, 'custom-temp');
    mkdirSync(customTemp, { recursive: true });
    const helperUrl = pathToFileURL(REGISTRY_HELPER).href;
    const childProgram = `await import(${JSON.stringify(helperUrl)});\nprocess.stdout.write('CAT_TEMPLATE_PATH=' + process.env.CAT_TEMPLATE_PATH + '\\n');`;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', childProgram], {
      cwd: API_ROOT,
      env: {
        ...process.env,
        TEMP: customTemp,
        TMP: customTemp,
        TMPDIR: customTemp,
      },
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

    const marker = result.stdout.split(/\r?\n/).find((line) => line.startsWith('CAT_TEMPLATE_PATH='));
    assert.ok(marker, result.stdout);
    const templatePath = marker.slice('CAT_TEMPLATE_PATH='.length);
    const processDirectory = dirname(templatePath);
    assertPathInside(templatePath, customTemp, 'isolated registry template');
    assert.notEqual(normalizedPath(processDirectory), normalizedPath(resolve(processDirectory, '..', '..')));
    assert.equal(existsSync(processDirectory), false, 'process temp directory must be removed after child exit');
    assert.deepEqual(
      readdirSync(customTemp),
      [],
      'custom temp root must remain and contain no leaked process directory',
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
