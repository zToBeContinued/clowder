---
doc_kind: reference
topics: [runtime, env, configuration]
created: 2026-07-08
---

# Clowder 运行时环境变量清单（核心 6 个）

> 说明：`packages/api/src` 下实际引用的 `process.env.*` 有数十个；本清单只收录**运行时基础设施**层最核心的 6 个（端口 / 地址 / 存储 / 模板 / 根目录），默认值均从代码 fallback 逐条核对，未编造。其余变量（TTS、Feishu、GitHub、遥测等）属于功能模块级配置，不在本清单范围。

| # | 变量名 | 用途 | 默认值 | 证据位置 |
|---|--------|------|--------|----------|
| 1 | `API_SERVER_PORT` | API 服务监听端口 | `3004` | `parseInt(process.env.API_SERVER_PORT ?? '3004', 10)` |
| 2 | `CAT_CAFE_API_URL` | API 基地址（供内部调用/回调） | `http://localhost:3004`（随 `API_SERVER_PORT` 变化） | `process.env.CAT_CAFE_API_URL ?? \`http://localhost:${API_SERVER_PORT ?? '3004'}\`` |
| 3 | `UPLOAD_DIR` | 上传文件存储目录 | 未设 → `SHARED_DEFAULT_UPLOAD_DIR`；`./uploads` → 兼容旧模块目录；其余按 `~` 展开后 `resolve` | `getDefaultUploadDir()` |
| 4 | `CAT_TEMPLATE_PATH` | 猫模板（cat-template）文件路径 | `DEFAULT_CAT_TEMPLATE_PATH` | `process.env.CAT_TEMPLATE_PATH ?? DEFAULT_CAT_TEMPLATE_PATH` |
| 5 | `CAT_CAFE_RUNTIME_ROOT` | 运行时根目录 | 未设时回退到显式入参，再回退 `process.cwd()` | `process.env.CAT_CAFE_RUNTIME_ROOT?.trim()` → `cwd()` |
| 6 | `CAT_CAFE_GLOBAL_CONFIG_ROOT` | 全局配置根目录 | 未设时回退 `projectRoot`，再回退 `homedir()` | `process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT` → `homedir()` |

## 备注
- 端口硬规：本地默认 API `3004` / 前端 `3003`（见 packages/api/CLAUDE.md 硬约束），与上表 `API_SERVER_PORT` 一致。
- 若你想要的「6 个」是另一组（例如身份类 `DEFAULT_CAT_ID` / `DEFAULT_OWNER_USER_ID`，或 MCP 类 `CAT_CAFE_MCP_SERVER_PATH`），告诉我，我按你的口径替换。
