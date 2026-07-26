#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const skillDir = resolve(scriptDir, '..');
const repoRoot = resolve(skillDir, '..', '..');

function parseArgs(argv) {
  const args = {
    name: '',
    creator: '',
    root: repoRoot,
    security: false,
    commit: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--creator') {
      args.creator = argv[++index] ?? '';
    } else if (arg === '--root') {
      args.root = resolve(argv[++index] ?? repoRoot);
    } else if (arg === '--security') {
      args.security = true;
    } else if (arg === '--no-commit') {
      args.commit = false;
    } else if (!args.name) {
      args.name = arg;
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }

  if (!args.name) {
    throw new Error('用法：init-project.mjs <project-name> [--creator name] [--security] [--root path] [--no-commit]');
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(args.name)) {
    throw new Error('项目名只能包含 a-z、A-Z、0-9、_、-');
  }
  return args;
}

function git(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'utf-8' });
}

function defaultCreator(root) {
  const user = git(['config', 'user.name'], root);
  return user.status === 0 && user.stdout.trim() ? user.stdout.trim() : 'unknown';
}

async function renderTemplate(templateName, variables) {
  const template = await readFile(resolve(skillDir, 'refs', templateName), 'utf-8');
  return template
    .replaceAll('{{PROJECT_NAME}}', variables.projectName)
    .replaceAll('{{ISO_DATE}}', variables.isoDate)
    .replaceAll('{{CREATOR}}', variables.creator);
}

async function writeNewFile(path, content) {
  if (existsSync(path)) {
    throw new Error(`文件已存在，拒绝覆盖：${path}`);
  }
  await writeFile(path, content, 'utf-8');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectDir = resolve(args.root, '.cat-cafe', 'projects', args.name);
  if (existsSync(projectDir)) {
    // Idempotent by design: the scaffold is project-level and shared by every channel of
    // that project, so "already there" is the desired end state, not an error. Failing
    // here used to break channel creation with an unretryable 500.
    console.log(`already initialized .cat-cafe/projects/${args.name}`);
    return;
  }

  const variables = {
    projectName: args.name,
    isoDate: new Date().toISOString(),
    creator: args.creator || defaultCreator(args.root),
  };

  await mkdir(projectDir, { recursive: true });
  await writeNewFile(resolve(projectDir, 'brief.md'), await renderTemplate('brief.template.md', variables));
  await writeNewFile(resolve(projectDir, 'progress.md'), await renderTemplate('progress.template.md', variables));
  await writeNewFile(resolve(projectDir, 'decisions.md'), await renderTemplate('decisions.template.md', variables));
  await writeNewFile(
    resolve(projectDir, 'handoff-index.md'),
    await renderTemplate('handoff-index.template.md', variables),
  );
  await writeNewFile(resolve(projectDir, 'handoff-log.md'), await renderTemplate('handoff-log.template.md', variables));
  if (args.security) {
    await writeNewFile(resolve(projectDir, 'security.md'), await renderTemplate('security.template.md', variables));
  }

  const relDir = `.cat-cafe/projects/${args.name}`;
  if (args.commit) {
    const inGitRepo = git(['rev-parse', '--is-inside-work-tree'], args.root);
    if (inGitRepo.status === 0) {
      const add = git(['add', relDir], args.root);
      if (add.status !== 0) throw new Error(add.stderr.trim() || 'git add failed');
      const commit = git(['commit', '-m', `docs: initialize ${args.name} project scaffold`], args.root);
      if (commit.status !== 0) throw new Error(commit.stderr.trim() || commit.stdout.trim() || 'git commit failed');
    }
  }

  console.log(`initialized ${relDir}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
