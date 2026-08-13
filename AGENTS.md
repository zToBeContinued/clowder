# Clowder — Agent Guide

> 本文件服务两类 AI:**平台内的猫**(被 Clowder 派工的 agent)与**维护型 agent**
> (在 IDE/CLI 里修平台本身的助手)。先确认你是哪一类,再读对应章节。
> **身份铁律:维护型 agent 不是猫,不要采用任何猫的身份;猫也不要执行维护章节
> 里的重启/杀进程操作**(2026-08-13 铲屎官明令)。

## 通用铁律(两类都必须遵守)

1. **数据圣域** — 不删/不清 Redis(生产 6399)、SQLite、任何持久化存储;测试用 6398。
2. **进程自保** — 不杀自己的父进程,不改坏自己的启动配置。
3. **配置不可变** — 不在运行时改 `cat-template.json`、`.cat-cafe/cat-catalog.json`、`.env`、MCP 配置;配置变更须人类操作。
4. **网络边界** — 只访问属于本服务的本地端口(前端 3003 / API 3004 / Redis 6399)。
5. **质量纪律** — bug 先找根因再修(复现→日志→调用链→根因→修复);修复=先红测试后绿;"完成"必须带证据(测试/截图/日志)。禁止 `reset --hard`、force-push、`git add .`。

## A. 平台内的猫(被派工的 agent)

- Codex/GPT 系猫的身份是 **Maine Coon**:代码审查与安全专家。审查结论必须有明确立场,每条 finding 标 P1(阻塞)/P2(应修)/P3(可选);不得自审自己的代码,优先跨家族互审(Maine Coon 审 Ragdoll,反之亦然)。Claude 系猫身份见 `CLAUDE.md`。
- 值守/定时复查:**禁止在回合内 sleep/轮询干等**(静默看门狗约 3 分钟判死整个回合),用 `schedule-tasks` 注册定时唤醒后立即收口。
- 进度汇报走 MCP `cat_cafe_post_progress`;MCP 不可用时的 `$CLI` 兜底在 Windows 已由 `bin/clowder.cmd` 垫片保障可执行。
- 协作技能在 `packages/api/cat-cafe-skills/`(feat-lifecycle / tdd / quality-gate / request-review / merge-gate)。

## B. 维护型 agent(修平台本身)

### 仓库与分支契约

- 本 worktree(`clowder-dev`)是用户实际使用的个人集成分支 `feature/kiro-acp-provider`;上游更新只能**合并进来**,绝不能覆盖 Kiro 集成。完整契约(含 Kiro 十条不变量)见 `D:\project\clowder\AGENTS.md`(父目录)。
- 只有用户明确要求才 push,只推 `origin`(用户 Fork),永不推 upstream。

### 常用命令

| 用途 | 命令 |
|---|---|
| 构建 API(含 shared) | `pnpm --dir packages/api run build` |
| Biome 检查/修复 | `pnpm check` / `pnpm check:fix`(单文件:`pnpm exec biome check --write <files>`) |
| Web 类型检查 | `packages/web` 下 `pnpm exec tsc --noEmit --incremental false` |
| 单测(node:test) | `packages/api` 下 `node --test <files>`(合并门槛测试集见父目录 AGENTS.md §6) |
| 单次健康巡检 | `pnpm diag:patrol`(`--json` 机器读,`--unblock` 自动解队列停摆) |
| 消息重复取证 | `pnpm diag:dup-messages [threadId]` |
| 停止平台 | `node scripts/stop.mjs`(树杀+孤儿清扫) |

### 启动方式

- 生产:双击 `start-clowder.cmd`(代理注入→Redis→kiro 更新→孤儿清扫→构建→启动)。
- 开发:双击 `start-clowder-dev.cmd`(同链路 + next dev 热更新 + debug 日志落盘)。
- 手动带参:`node scripts/start-entry.mjs start [--dev] [--debug] [--quick]`;`--debug` 让 pino 写 `packages/api/data/logs/api/api.log`(CLI 原始 stderr 落盘,**排障必开**)。
- 重启前必须确认无在途任务(`pnpm diag:patrol` 看 active=0),启动器会整树接管旧实例。

### 可观测性(先看日志再分析,不要猜)

- `packages/api/data/logs/invocations/<catId>/*.log` — 每次派工的事件时间线(start/text/tool_use/error/done)。
- `packages/api/data/logs/api/api.log` — pino JSON(debug 模式);`level>=50` 行含 CLI 原始 stderr。
- `packages/api/data/logs/threads/<threadId>.log` — thread 消息流水。
- 队列实况:`GET /api/threads/{id}/queue`(header `x-cat-cafe-user: default-user`),返回 queue 条目与 activeInvocations。
- 巡检方法论与事故速查表:`docs/diag-patrol-loop.md`。

### Windows 特有暗礁(每条都是实弹换来的)

1. `.ps1` 保持 **ASCII-only**:PowerShell 5.1 按 ANSI 读无 BOM 脚本,非 ASCII 注释会破坏解析。
2. **PowerShell 5.1 向原生命令转发含引号/换行的参数是有损的**:CLI 一律直启真实可执行体(cursor-agent 已解析 versions 目录直启捆绑 node),prompt 永远不要过 shell 二次解析。
3. `child.kill()` 只杀直接子进程:终止 CLI 必须 **taskkill /T 整树**(`cli-spawn` 已内置;脚本用 `killPidTree`)。
4. 无扩展名脚本不可直接执行:cmd 会转 ShellExecute 弹"选择应用"对话框,必须配 `.cmd` 垫片(`bin/clowder.cmd`)。
5. PATH 分隔符是 `;` 不是 `:`;子进程环境注入时按 `platform` 分支。
6. 判断 taskkill 成败看"进程是否消失",不要解析本地化输出(中文系统 GBK 乱码)。
7. PID 会复用:按 pid 判定进程归属时要交叉核对创建时间。
8. 存活探针的 CPU 采样必须覆盖**全部后代**(工具跑在孙进程,只看直接子进程会误判闲置)。

### 临时文件/缓存策略

- 测试临时目录(`%TEMP%\cat-cafe-test-*`):启动自愈清扫(≥24h 必删,<24h 看 pid 死活),见 `packages/api/test/helpers/sweep-stale-test-temp.js`。
- 孤儿 agent 进程:启动/停止/Ctrl+C 三路自动清扫(`scripts/sweep-orphan-agents.mjs`,判定=派工标记+父进程已死)。
- kiro 安装器缓存:启动器自动更新+清扫。API 日志 14 天轮转。

### 已知债务(修前先读对应事故记录)

- `CliRawArchive` 无保留策略,只增不减。
- `system-prompt-builder.test.js` 有 2 个"行首 @ 时代"旧文案断言未跟进 a4d2f96b。
