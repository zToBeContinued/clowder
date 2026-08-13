import type { ToolPolicy } from '@cat-cafe/shared';
import { detectGovernanceMagicWord } from './SystemPromptBuilder.js';

export type ContextLayerMode = 'legacy' | 'layered';

export interface ContextLayerPlan {
  readonly mode: ContextLayerMode;
  readonly l1Core: true;
  readonly l2ProjectContext: boolean;
  readonly l3GovernanceSource: boolean;
  readonly projectContextDeferred: boolean;
  readonly reason: string;
  readonly signals: readonly string[];
}

const DISABLED_VALUES = new Set(['0', 'false', 'off', 'disabled', 'no']);
const ENABLED_VALUES = new Set(['1', 'true', 'on', 'enabled', 'yes']);

const PROJECT_CONTEXT_SIGNALS: readonly { name: string; pattern: RegExp }[] = [
  { name: 'explicit-project', pattern: /项目|工程|仓库|repo|repository|worktree|工作区|代码库/i },
  {
    name: 'code-action',
    pattern: /修复|改造|实现|落地|推进|执行|验收|部署|重启|排查|调试|测试|构建|build|test|debug|fix|implement|deploy/i,
  },
  {
    name: 'code-surface',
    pattern:
      /代码|文件|目录|路径|接口|API|组件|页面|路由|服务|前端|后端|数据库|Redis|SQLite|PM2|Node|pnpm|TypeScript|React|Next/i,
  },
  {
    name: 'local-reference',
    pattern: /\/Users\/|localhost:\d+|\.md\b|\.tsx?\b|\.jsx?\b|\.json\b|\.css\b|packages\/|scripts\/|docs\//i,
  },
  { name: 'task-operation', pattern: /task\s*#?\d+|任务|认领|待验收|in_review|done|todo|blocked/i },
];

const LIGHTWEIGHT_DISCUSSION_SIGNALS: readonly { name: string; pattern: RegExp }[] = [
  { name: 'feynman', pattern: /费曼|解释一下|讲下|说下|是什么|为什么|怎么看|如何理解|区别|联系/i },
  { name: 'ack', pattern: /^(ok|OK|好的|收到|确认|可以|继续|看到了|明白)$/ },
];

export function isContextLayerRoutingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.CAT_CAFE_CONTEXT_LAYERS?.trim().toLowerCase();
  return raw ? ENABLED_VALUES.has(raw) && !DISABLED_VALUES.has(raw) : false;
}

function collectSignals(message: string, specs: readonly { name: string; pattern: RegExp }[]): string[] {
  return specs.filter((spec) => spec.pattern.test(message)).map((spec) => spec.name);
}

export function resolveContextLayerPlan(input: {
  readonly message: string;
  readonly toolPolicy: ToolPolicy;
  readonly loadStandardContext: boolean;
  readonly env?: NodeJS.ProcessEnv;
}): ContextLayerPlan {
  const enabled = isContextLayerRoutingEnabled(input.env);
  const l3GovernanceSource = Boolean(detectGovernanceMagicWord(input.message));

  if (!enabled) {
    return {
      mode: 'legacy',
      l1Core: true,
      l2ProjectContext: input.loadStandardContext,
      l3GovernanceSource,
      projectContextDeferred: false,
      reason: 'CAT_CAFE_CONTEXT_LAYERS disabled; keep legacy standard-context injection',
      signals: ['legacy'],
    };
  }

  if (!input.loadStandardContext || input.toolPolicy === 'minimal') {
    return {
      mode: 'layered',
      l1Core: true,
      l2ProjectContext: false,
      l3GovernanceSource,
      projectContextDeferred: false,
      reason: 'minimal tool policy skips L2 project context',
      signals: ['minimal'],
    };
  }

  const projectSignals = collectSignals(input.message, PROJECT_CONTEXT_SIGNALS);
  if (projectSignals.length > 0) {
    return {
      mode: 'layered',
      l1Core: true,
      l2ProjectContext: true,
      l3GovernanceSource,
      projectContextDeferred: false,
      reason: `L2 project context matched: ${projectSignals.join(',')}`,
      signals: projectSignals,
    };
  }

  const discussionSignals = collectSignals(input.message.trim(), LIGHTWEIGHT_DISCUSSION_SIGNALS);
  return {
    mode: 'layered',
    l1Core: true,
    l2ProjectContext: false,
    l3GovernanceSource,
    projectContextDeferred: true,
    reason:
      discussionSignals.length > 0
        ? `lightweight discussion matched: ${discussionSignals.join(',')}`
        : 'no project/code/action signal in latest user message',
    signals: discussionSignals.length > 0 ? discussionSignals : ['no-l2-signal'],
  };
}
