---
feature_ids: [F161]
related_features: [F149, F143, F050]
topics: [acp, carrier, generalization, runtime]
doc_kind: spec
created: 2026-04-13
---

# F161: ACP Carrier Generalization — 多载体复用同一 Runtime Policy

> **Status**: done | **Owner**: Kiro | **Priority**: P2

## Why

F149 交付了完整的 ACP runtime operations（进程池 / session lease / lifecycle / watchdog），但第一载体只有 Gemini。team experience（2026-03-31）：

> "我们要支持acp这个协议 支持Siameseacp接入 其实 codex 和claude code也支持这个协议。"

当前 `AcpProcessPool` 和 `AcpClient` 的接口没有 Gemini-specific 的硬依赖，但“没有 hard dependency ≠ 已验证可泛化”。F161 以官方 `kiro-cli acp` 作为第二个、非 Gemini ACP carrier，验证同一套进程池、session lease、MCP 注入、事件转换与取消策略可以承载不同 provider。

**Scope 来源**：从 F149 Phase D 拆出（2026-04-13 team lead 拍板）。Gemini 保留为第一载体，不在本特性中重构。

## What

### Phase A: 第二载体验证

1. 将 Kiro CLI 映射到 F149 的通用 ACP runtime policy
2. 明确 multiplex 与 non-multiplex carrier 在 acquire/release/pending spawn 上的差异
3. 文档化 provider profile、薄 adapter 与通用 ACP runtime policy 的边界
4. 将 Kiro 接入本地 CLI 探测、Cats CRUD/runtime registry 与 Hub 配置界面

## Provider Profile 与通用 Runtime 的边界

### Kiro-specific profile / adapter

`kiro-acp-profile.ts` 和 `KiroAcpAdapter.ts` 只负责 provider 差异：

- 启动入口固定为 `kiro-cli acp`；若用户参数首项已是 `acp` 则去重。
- `defaultModel` 仅在 trim 后非空时作为 `session/set_model` override；留空继续使用 Kiro CLI 当前默认模型。
- Kiro 声明 `supportsMultiplexing=false`。
- builtin MCP 只允许 `cat-cafe`、`cat-cafe-collab`、`cat-cafe-memory`、`cat-cafe-signals`。
- metadata 使用 `provider: 'kiro'`；Kiro 使用本机 CLI 登录状态，不创建或绑定 Clowder `accountRef`。
- 有 `sessionId` 时只执行 `session/load`；无 `sessionId` 时只执行 `session/new`。Kiro session 是持久 session，不标记 `ephemeralSession`。
- 将 system prompt 前置到用户 prompt；Kiro-specific missing-session 响应只在 ACP code `-32603` 且 `error.data` 匹配 `Session not found: ...` 时转换为统一用户文案。

### 通用 ACP runtime policy

以下能力继续由 provider-neutral 组件提供，没有复制一套 Kiro process/session runtime：

- `AcpProcessPool`：按 `{ projectPath, providerProfile }` 建 key，管理进程 acquire/release、idle reuse、lease 与 eviction。
- `AcpClient`：JSON-RPC initialize/request/response、数字或字符串 ID、prompt stream、权限请求、`session/set_model`、session-scoped cancel。
- `acp-session-env` / `acp-mcp-resolver`：callback env materialization、builtin/project MCP 解析。
- `acp-event-transformer`：将 ACP update 转换为统一 agent events。
- registry 与 queue：按 provider 创建 adapter，并沿用既有输出门禁、session chain 和 runtime policy。

## Non-multiplex Process Policy

Gemini 的 multiplex 行为保持不变。对 `supportsMultiplexing=false` 的 Kiro：

1. 只能复用 `leaseCount === 0` 的 idle process；active process 不会被第二个 invocation 共享。
2. 相同 pool key 的并发 cold start 不合并 pending spawn；每个并发 lease 获得独立 process。
3. lease release 后进程回到 idle，后续 invocation 可以复用。
4. client factory 接收实际 `PoolKey`，因此 bootstrap cwd 使用本次 lease 的真实 `projectPath`，而不是 registry 初始化时的固定目录。

这仍是同一个 `AcpProcessPool`，差异由 profile capability 驱动，不是 provider 名称分支。

## Session、Model、MCP 与安全语义

- **Session**：new/load 二选一；模型 override 仅在已配置时发送；abort 使用当前 session 的 `cancelSession`，并保证 exactly once；`finally` 始终 release lease。
- **MCP**：支持 stdio 与 HTTP；过滤 Kiro 声明不支持的 SSE。`mcpSupport=false` 时 builtin 与 user project MCP 均不注入；启用时 callback env 仍走通用 materialization。
- **Permission**：无人值守 fallback 优先 `allow_once`，然后 `reject_once`、`reject_always`；没有安全选项则 `cancelled`，绝不默认选择 `allow_always`。
- **Notification**：只有标准 `session/update` 进入 prompt listener。`_kiro.dev/*` 等扩展 notification 只记 debug，不污染输出 stream，也不刷新基于标准更新的 liveness/watchdog。
- **JSON-RPC ID**：按字段是否存在识别 request/response，正确支持 Kiro 发出的数字 ID（包括 `0`）。

## Product Integration

- shared `ClientId` additive 加入 `kiro`，但 builtin account family、builtin account ID 与旧 protocol routing 均保持 `null`。
- 本地探测只执行固定 allowlist 中的 `kiro-cli --version` 与只读 `settings list --format json`；settings parser 仅读取 `chat.defaultModel` 和 `chat.modelDefaults` 的明确模型字段。
- Windows 在 PATH 缺失时可回退到 `%LOCALAPPDATA%\Kiro-Cli\kiro-cli.exe`。
- Cats API 默认生成 `{ command: 'kiro-cli', outputFormat: 'acp' }`，拒绝非空 `accountRef`，默认启用 MCP，并将 adapter mode 报告为 `acp`。
- Hub 可探测并采用 Kiro；不显示账号选择器，Model 可留空，切换 provider 时清除旧账号绑定并默认启用 MCP。

## Verification Evidence

自动化测试覆盖：

- `acp-client.test.js`：`session/set_model`、`id=0`、permission fail-closed、Kiro extension notification 隔离。
- `acp-process-pool.test.js`：non-multiplex active/pending 不共享、release 后复用、factory 获得实际 pool key。
- `kiro-acp-profile.test.js` / `kiro-acp-adapter.test.js`：argv、model、builtin whitelist、cwd、new/load、MCP、事件转换、missing session、cancel exactly once 与 release。
- `client-routing.test.js`、`local-cli-probe.test.js`、`cli-resolve.test.js`：shared routing 边界、安全 settings parser 与 Windows resolver。
- `cats-routes-runtime-crud.test.js`：默认 CLI/MCP、无账号、PATCH 清旧账号与 registry runtime。
- `hub-cat-editor.test.tsx`：Kiro adopt、无账号 UI、可空模型、payload 清账号与默认 MCP。

本机确认的 CLI 为 `kiro-cli-chat 2.12.2`，`kiro-cli acp` 可启动，initialize 能力声明支持 loadSession/HTTP、SSE unsupported。**本特性尚未执行真实模型 prompt，因此这里不声称完整的模型端到端调用已验证。** 自动化测试验证的是 Clowder integration contract 与 runtime policy。

## Acceptance Criteria

### Phase A

- [x] AC-A1: Kiro 作为非 Gemini ACP carrier 映射到相同 runtime policy，没有重写池化/lease 模型
- [x] AC-A2: provider-specific profile/adapter 与通用 ACP runtime policy 的边界有明文文档

## Dependencies

- **Evolved from**: F149 Phase D（scope 收窄拆出）
- **Related**: F143（protocol-agnostic kernel 抽象）
- **Related**: F050（外部 agent 接入契约）
