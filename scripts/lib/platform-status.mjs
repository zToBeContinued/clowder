import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import { homedir } from 'node:os';
import { basename, resolve } from 'node:path';

const DEFAULT_API_PORT = '3004';
const DEFAULT_WEB_PORT = '3003';

export function pidIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'EPERM') return true;
    return false;
  }
}

export function readDotEnvValues(dotEnvPath) {
  if (!existsSync(dotEnvPath)) return {};

  const values = {};
  for (const rawLine of readFileSync(dotEnvPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#')) continue;
    const separatorIndex = line.indexOf('=');
    if (separatorIndex <= 0) continue;

    const key = line.slice(0, separatorIndex).trim();
    const value = line
      .slice(separatorIndex + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '');
    values[key] = value;
  }
  return values;
}

function resolvePortValue(dotEnv, env, key, defaultValue) {
  const dotEnvValue = dotEnv[key];
  if (dotEnvValue !== undefined && dotEnvValue !== '') return dotEnvValue;

  const envValue = env[key];
  if (envValue !== undefined && envValue !== '') return envValue;

  return defaultValue;
}

export function resolveWindowsStatusPorts({ projectRoot = process.cwd(), env = process.env } = {}) {
  const dotEnv = readDotEnvValues(resolve(projectRoot, '.env'));
  return {
    apiPort: resolvePortValue(dotEnv, env, 'API_SERVER_PORT', DEFAULT_API_PORT),
    webPort: resolvePortValue(dotEnv, env, 'FRONTEND_PORT', DEFAULT_WEB_PORT),
  };
}

export const resolveStatusPorts = resolveWindowsStatusPorts;

export function checkTcpPort({ host = '127.0.0.1', port, timeoutMs = 750 } = {}) {
  return new Promise((resolvePort) => {
    const socket = net.createConnection({ host, port: Number(port) });
    let settled = false;

    const settle = (isOpen) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePort(isOpen);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => settle(true));
    socket.once('timeout', () => settle(false));
    socket.once('error', () => settle(false));
  });
}

export async function checkApiReady({ apiPort, timeoutMs = 1000 } = {}) {
  if (typeof fetch !== 'function') {
    return { ok: false, detail: 'fetch unavailable' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${apiPort}/ready`, { signal: controller.signal });
    if (!response.ok) return { ok: false, detail: `HTTP ${response.status}` };

    const body = await response.json().catch(() => null);
    if (body?.status === 'ready') return { ok: true, detail: 'ready' };
    return { ok: false, detail: body?.status ? String(body.status) : 'unexpected response' };
  } catch (error) {
    return { ok: false, detail: error?.name === 'AbortError' ? 'timeout' : 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

export function buildWindowsStatus({
  projectRoot = process.cwd(),
  env = process.env,
  pidIsRunning: checkPid = pidIsRunning,
} = {}) {
  const runDir = resolve(projectRoot, '.cat-cafe', 'run', 'windows');
  if (!existsSync(runDir)) {
    return {
      exitCode: 1,
      lines: [`Cat Cafe Windows services not running (no run directory: ${runDir})`],
    };
  }

  const { apiPort, webPort } = resolveWindowsStatusPorts({ projectRoot, env });
  const requiredServices = [
    { pidFile: `api-${apiPort}.pid`, running: false },
    { pidFile: `web-${webPort}.pid`, running: false },
  ];

  const lines = ['Cat Cafe Windows status'];
  for (const service of requiredServices) {
    const pidPath = resolve(runDir, service.pidFile);
    const label = basename(service.pidFile, '.pid');
    if (!existsSync(pidPath)) {
      lines.push(`  ${label}: not running (missing PID file)`);
      continue;
    }

    const pid = Number.parseInt(readFileSync(pidPath, 'utf8').trim(), 10);
    if (Number.isNaN(pid)) {
      lines.push(`  ${label}: invalid PID file`);
      continue;
    }

    service.running = checkPid(pid);
    lines.push(`  ${label}: ${service.running ? 'running' : 'not running'} (PID: ${pid})`);
  }

  return {
    exitCode: requiredServices.every((service) => service.running) ? 0 : 1,
    lines,
  };
}

export async function buildUnixStatus({
  projectRoot = process.cwd(),
  env = process.env,
  daemonStateDir = resolve(homedir(), '.cat-cafe'),
  pidIsRunning: checkPid = pidIsRunning,
  checkPort = checkTcpPort,
  checkReady = checkApiReady,
} = {}) {
  const lines = ['Cat Cafe Unix status'];
  const daemonPidPath = resolve(daemonStateDir, 'daemon.pid');

  if (existsSync(daemonPidPath)) {
    const pid = Number.parseInt(readFileSync(daemonPidPath, 'utf8').trim(), 10);
    if (!Number.isNaN(pid) && checkPid(pid)) {
      lines.push(`  daemon: running (PID: ${pid})`);
    } else {
      lines.push(
        Number.isNaN(pid) ? '  daemon: not running (invalid PID file)' : `  daemon: not running (stale PID: ${pid})`,
      );
    }
  } else {
    lines.push('  daemon: not running (missing PID file)');
  }

  const { apiPort, webPort } = resolveStatusPorts({ projectRoot, env });
  const [apiRunning, webRunning] = await Promise.all([checkPort({ port: apiPort }), checkPort({ port: webPort })]);
  const ready = apiRunning ? await checkReady({ apiPort }) : { ok: false, detail: 'port closed' };

  lines.push(`  api-${apiPort}: ${apiRunning ? 'running' : 'not running'} (${ready.detail})`);
  lines.push(`  web-${webPort}: ${webRunning ? 'running' : 'not running'}`);

  return {
    exitCode: apiRunning && webRunning && ready.ok ? 0 : 1,
    lines,
  };
}

export async function buildPlatformStatus(options = {}) {
  if (process.platform === 'win32') return buildWindowsStatus(options);
  return buildUnixStatus(options);
}

export async function runPlatformStatus(options = {}) {
  const result = await buildPlatformStatus(options);
  for (const line of result.lines) {
    console.log(line);
  }
  process.exit(result.exitCode);
}

export function runWindowsStatus(options = {}) {
  const result = buildWindowsStatus(options);
  for (const line of result.lines) {
    console.log(line);
  }
  process.exit(result.exitCode);
}
