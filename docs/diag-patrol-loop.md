---
feature_ids: []
topics: [diagnostics, runtime-ops, queue, agent-lifecycle]
doc_kind: runbook
created: 2026-08-13
---

# Clowder 平台巡检循环(Patrol Loop)Runbook

> 供任何 AI(Clowder 猫、Cursor/Claude/Codex agent)或人类周期性守护平台用。
> 单次巡检入口:`pnpm diag:patrol`(等价 `node scripts/patrol-clowder.mjs`)。
> 源自 2026-08-12/13 通宵实战:幽灵写手、假超时、同猫双进程、队列停摆四类事故。

## 一、单次巡检做什么

`scripts/patrol-clowder.mjs` 一次扫五项,只读为主:

| 巡检项 | 数据源 | 异常含义 |
|---|---|---|
| 端口 | API 3004 / 前端 3003 监听 | 服务挂了 |
| 队列/活跃 | `GET /api/threads/:id/queue`(全 thread) | queued>0 且 active=0 = 疑似停摆 |
| 调用活动 | `packages/api/data/logs/invocations/**` mtime | 全平台静默时长 |
| 高级别错误 | `packages/api/data/logs/api/api.log` level≥50 | CLI stderr、异常退出等原始证据 |
| 孤儿 agent | 命令行带派工标记 + 父进程已死(dry-run) | 幽灵写手风险 |

输出结论 `healthy / warning / stalled / critical` + 建议动作;退出码 0/1/2 供循环分支;`--json` 给机器读。

## 二、怎么架循环

- 节奏:10 分钟一轮足够(回合级事故的伤害窗口约 15 分钟)。
- Cursor agent:后台 shell `while(true){ sleep 600; echo TICK }` + 输出监听唤醒,tick 时跑 `pnpm diag:patrol`。
- 任何 AI/cron:循环调 `node scripts/patrol-clowder.mjs --json`,按 verdict 分支。

## 三、判定与动作规则(铁律)

1. **有活跃调用时,绝不重启、绝不补发消息、绝不杀进程。** 长回合(30-80 分钟)是正常的:只要 invocation 日志还在增长、事件是 tool_use/tool_result 循环,就是真在干活(测试类工具单次 2-5 分钟静默属正常)。
2. **停摆判定必须三条同时满足**:0 活跃 + 有排队条目 + 全平台静默 ≥2 分钟(转场窗口有几十秒的 0/0 假象)。处置:`POST /api/threads/{id}/queue/next`(JSON 头 + `{}` body),或 `pnpm diag:patrol --unblock` 自动做。
3. **warning 类(错误/孤儿)只取证不自动动手**:错误读 api.log 对应行(level≥50 行含原始 stderr);孤儿先 `node scripts/sweep-orphan-agents.mjs --dry-run` 复核再清扫。
4. **critical(端口挂)**:`node scripts/stop.mjs` → 带代理环境(`HTTP_PROXY`/`HTTPS_PROXY`=`http://127.0.0.1:7890`,`NO_PROXY`=`localhost,127.0.0.1,::1`)独立窗口跑 `node scripts/start-entry.mjs start --debug --quick`。`--debug` 让 pino 落盘(否则 CLI stderr 只在控制台,取证靠猜);`--quick` 跳过构建(dist 新鲜时)。

## 四、事故速查表(实战沉淀)

| 症状 | 根因方向 | 取证/处置 |
|---|---|---|
| CLI 秒退 code 1 ×2 | 参数被拆(历史含引号代码片段)/模型无权限/会话损坏 | api.log 找 `CLI stderr` 行看原文;`[model_unavailable]` = 账号模型权限(直连是区域清单,走代理才有 claude/gpt) |
| 回合"结束"但队列条目永远 processing | 收口路径未消费条目 + 事件驱动无兜底 | `queue/next` 推进;条目有 10 分钟陈旧防御,7 天过期 |
| 猫说在干活但无输出、点停止才出消息 | 回合语义:最终消息在回合收口时落框 | 正常;若猫用 sleep 干等值守,提示词已禁止,让它用 schedule-tasks |
| 同猫两个进程写同一项目 | 超时/取消只杀包装层(已修:树击杀);调用释放但进程未终止(待修) | 进程表查 cursor-agent 启动时间;确认被平台遗弃后 `taskkill /pid X /T /F` |
| 服务关了还有 agent 在写文件 | 孤儿(父链断) | 启动/停止/Ctrl+C 已自动清扫;手动 `node scripts/sweep-orphan-agents.mjs` |

## 五、边界

- 巡检身份用 `x-cat-cafe-user: default-user`(本地单用户);补发消息属于用户级动作,仅在停摆且用户明确授权的场景使用 `POST /api/messages`。
- 本 runbook 只覆盖平台运行态;猫的业务产出对错不在巡检范围。
