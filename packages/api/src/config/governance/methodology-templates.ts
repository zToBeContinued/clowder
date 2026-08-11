/**
 * F070: Methodology skeleton templates
 *
 * Minimal templates generated in external projects on first bootstrap.
 * Only created if the target file does not already exist (no-overwrite).
 */

export interface MethodologyTemplate {
  readonly relativePath: string;
  readonly content: string;
}

const BACKLOG_TEMPLATE = `---
topics: [backlog]
doc_kind: note
created: {{DATE}}
---

# Feature Roadmap

> **Rules**: Only active Features (idea/spec/in-progress/review). Move to done after completion.
> Details in \`docs/features/Fxxx-*.md\`.

| ID | Name | Status | Owner | Link |
|----|------|--------|-------|------|
`;

const SOP_TEMPLATE = `---
topics: [sop, workflow]
doc_kind: note
created: {{DATE}}
---

# Standard Operating Procedure

## Workflow (6 steps)

| Step | What | Skill |
|------|------|-------|
| 1 | Create worktree | \`worktree\` |
| 2 | Self-check (spec compliance) | \`quality-gate\` |
| 3 | Peer review | \`request-review\` / \`receive-review\` |
| 4 | Merge gate | \`merge-gate\` |
| 5 | PR + cloud review | (merge-gate handles) |
| 6 | Merge + cleanup | (SOP steps) |

## Code Quality

- Biome: \`pnpm check\` / \`pnpm check:fix\`
- Types: \`pnpm lint\`
- File limits: 200 lines warn / 350 hard cap
`;

const FEATURE_TEMPLATE = `---
feature_ids: [Fxxx]
related_features: []
topics: []
doc_kind: spec
created: {{DATE}}
---

# Fxxx: Feature Name

> Status: spec | Owner: TBD

## Why
## What
## Acceptance Criteria
- [ ] AC-1: ...

## Dependencies
## Risk
## Open Questions
`;

const AGENT_MEMORY_TEMPLATE = `# {Agent 名称} 记忆

> 模板文件。具体 agent 首次接入时，可复制为 \`.cat-cafe/memory/{catId}.md\`。

## 当前状态

- 最后活跃：（待更新）
- 正在处理：无
- 上次交付：无

## 已关闭决策（别再提了）

（暂无已关闭决策。当某个方案被明确否决时，在这里记录原因，防止后续 session 重复提议。）

## 行为偏好（用户纠正过的）

（暂无。当用户纠正了 agent 的行为方式时，在这里记录，避免同一个错误犯两次。）

## 环境 gotcha

（暂无。记录容易踩坑的端口、路径、命令、运行方式。）
`;

const LESSONS_TEMPLATE = `# 公共踩坑记录

> 多个 agent 都踩过的坑，或一次事故影响多个 agent 的经验。
> 只追加，不删除。每条附日期和来源。
> 这里的内容会被低优先级注入到 agent prompt 中，不覆盖当前用户指令、Pack 指令、输出协议或代码事实。

（暂无记录。运行一段时间后，用 \`memory-consolidator\` skill 整理跨 agent 的共性经验。）
`;

const PROJECT_PROGRESS_TEMPLATE = `# {项目名称} 进度

## 当前阶段

（描述项目当前处于什么阶段。）

## 已完成

（暂无。格式：\`- [x] 描述，附 task # 或 commit hash\`）

## 进行中

（暂无。格式：\`- 描述，谁在做\`）

## 待做

- [ ] （待填写）

## 关键决策

（暂无。格式：\`- 决策内容（日期）\`。只追加，不删除。）

## 验收标准

（待填写。定义项目完成的条件。）
`;

const CONTEXT_INDEX_TEMPLATE = `# 上下文索引

> 告诉 agent 进入这个项目时应该先读什么、哪些目录可以跳过。
> 每次 session 开始时，agent 应先读本文件定位关键信息。

## 必读文件

- \`README.md\` — 项目概览和当前状态
- \`BACKLOG.md\` — 待办任务
- \`.cat-cafe/LESSONS.md\` — 公共踩坑记录

## 可选参考

（根据项目情况填写，例如 \`refs/plans/\` 或落地方案文档路径。）

## 默认跳过

（大型目录或无需 agent 关注的内容，例如 \`vendor/\`、\`node_modules/\`、\`_archive/\`。）
`;

const HANDOFF_TEMPLATE = `# 当前交接状态

> 当 agent session 中断、换 agent、或换 session 时，在这里写交接信息。
> 下一个 session 的 agent 应先读本文件恢复上下文。

## 状态

- 交接状态：无活跃交接
- 上次更新：（待填写）

## 交接内容

（中断时填写：做到哪了、下一步是什么、有什么阻塞、验证命令是什么。）

## 交接历史

（记录历次交接，附日期。只追加。）
`;

/**
 * Raw templates with `{{DATE}}` placeholders left in place.
 * Used by governance-eject to recognize untouched skeleton files
 * (same content modulo the creation date) that are safe to remove.
 */
export function getRawMethodologyTemplates(): MethodologyTemplate[] {
  return [
    { relativePath: 'BACKLOG.md', content: BACKLOG_TEMPLATE },
    { relativePath: 'docs/SOP.md', content: SOP_TEMPLATE },
    { relativePath: 'docs/features/.gitkeep', content: '' },
    { relativePath: 'docs/decisions/.gitkeep', content: '' },
    { relativePath: 'docs/discussions/.gitkeep', content: '' },
    { relativePath: 'docs/features/TEMPLATE.md', content: FEATURE_TEMPLATE },
    { relativePath: '.cat-cafe/memory/_TEMPLATE.md', content: AGENT_MEMORY_TEMPLATE },
    { relativePath: '.cat-cafe/LESSONS.md', content: LESSONS_TEMPLATE },
    { relativePath: '.cat-cafe/projects/_TEMPLATE-progress.md', content: PROJECT_PROGRESS_TEMPLATE },
    { relativePath: '.cat-cafe/context-index.md', content: CONTEXT_INDEX_TEMPLATE },
    { relativePath: '.cat-cafe/handoff/current.md', content: HANDOFF_TEMPLATE },
    { relativePath: '.cat-cafe/handoff/.gitkeep', content: '' },
  ];
}

export function getMethodologyTemplates(): MethodologyTemplate[] {
  const date = new Date().toISOString().slice(0, 10);
  const fill = (tpl: string) => tpl.replace(/\{\{DATE\}\}/g, date);

  return [
    { relativePath: 'BACKLOG.md', content: fill(BACKLOG_TEMPLATE) },
    { relativePath: 'docs/SOP.md', content: fill(SOP_TEMPLATE) },
    { relativePath: 'docs/features/.gitkeep', content: '' },
    { relativePath: 'docs/decisions/.gitkeep', content: '' },
    { relativePath: 'docs/discussions/.gitkeep', content: '' },
    { relativePath: 'docs/features/TEMPLATE.md', content: fill(FEATURE_TEMPLATE) },
    { relativePath: '.cat-cafe/memory/_TEMPLATE.md', content: fill(AGENT_MEMORY_TEMPLATE) },
    { relativePath: '.cat-cafe/LESSONS.md', content: fill(LESSONS_TEMPLATE) },
    { relativePath: '.cat-cafe/projects/_TEMPLATE-progress.md', content: fill(PROJECT_PROGRESS_TEMPLATE) },
    { relativePath: '.cat-cafe/context-index.md', content: fill(CONTEXT_INDEX_TEMPLATE) },
    { relativePath: '.cat-cafe/handoff/current.md', content: fill(HANDOFF_TEMPLATE) },
    { relativePath: '.cat-cafe/handoff/.gitkeep', content: '' },
  ];
}
