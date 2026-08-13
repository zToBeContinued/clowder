import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { ProjectInitFastLaneInput } from './FastLaneRouter.js';

const execFileAsync = promisify(execFile);
const DEFAULT_FAST_LANE_TIMEOUT_MS = 15_000;

export type FastLaneExecutionResult =
  | {
      status: 'skipped';
      reason: string;
      durationMs: number;
    }
  | {
      status: 'succeeded';
      stdout: string;
      stderr: string;
      durationMs: number;
      files: string[];
    }
  | {
      status: 'failed';
      reason: string;
      stdout: string;
      stderr: string;
      durationMs: number;
      exitCode?: number;
      signal?: string;
    };

export interface FastLaneExecutorOptions {
  readonly monorepoRoot: string;
  readonly timeoutMs?: number;
}

function isInside(parent: string, child: string): boolean {
  const normalizedParent = resolve(parent);
  const normalizedChild = resolve(child);
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}${sep}`);
}

async function isExistingDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function projectFiles(projectName: string): string[] {
  return [
    `.cat-cafe/projects/${projectName}/brief.md`,
    `.cat-cafe/projects/${projectName}/progress.md`,
    `.cat-cafe/projects/${projectName}/decisions.md`,
    `.cat-cafe/projects/${projectName}/handoff-index.md`,
    `.cat-cafe/projects/${projectName}/handoff-log.md`,
  ];
}

export class FastLaneExecutor {
  private readonly monorepoRoot: string;
  private readonly timeoutMs: number;

  constructor(options: FastLaneExecutorOptions) {
    this.monorepoRoot = resolve(options.monorepoRoot);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_FAST_LANE_TIMEOUT_MS;
  }

  async executeProjectInit(input: ProjectInitFastLaneInput): Promise<FastLaneExecutionResult> {
    const startedAt = Date.now();
    const root = resolve(input.root);
    const projectsRoot = resolve(root, '.cat-cafe', 'projects');
    const targetProjectDir = resolve(projectsRoot, input.projectName);
    if (!isInside(projectsRoot, targetProjectDir)) {
      return {
        status: 'skipped',
        reason: 'project path escaped .cat-cafe/projects whitelist',
        durationMs: Date.now() - startedAt,
      };
    }
    if (!(await isExistingDirectory(root))) {
      return {
        status: 'skipped',
        reason: 'explicit project root does not exist or is not a directory',
        durationMs: Date.now() - startedAt,
      };
    }

    const scriptPath = resolve(this.monorepoRoot, 'cat-cafe-skills', 'project-init', 'scripts', 'init-project.mjs');
    const args = [scriptPath, input.projectName, '--root', root, '--no-commit'];
    if (input.creator) args.push('--creator', input.creator);
    if (input.security) args.push('--security');

    try {
      const result = await execFileAsync(process.execPath, args, {
        cwd: this.monorepoRoot,
        timeout: this.timeoutMs,
        maxBuffer: 1024 * 1024,
      });
      return {
        status: 'succeeded',
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim(),
        durationMs: Date.now() - startedAt,
        files: input.security
          ? [...projectFiles(input.projectName), `.cat-cafe/projects/${input.projectName}/security.md`]
          : projectFiles(input.projectName),
      };
    } catch (err) {
      const error = err as Error & {
        stdout?: string;
        stderr?: string;
        code?: number;
        signal?: string;
      };
      return {
        status: 'failed',
        reason: error.message,
        stdout: error.stdout?.trim() ?? '',
        stderr: error.stderr?.trim() ?? '',
        durationMs: Date.now() - startedAt,
        ...(typeof error.code === 'number' ? { exitCode: error.code } : {}),
        ...(error.signal ? { signal: error.signal } : {}),
      };
    }
  }
}
