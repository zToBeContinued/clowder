/**
 * MCP Prompt Injector
 * 给没有原生 MCP 支持的猫 (Codex/Gemini) 注入 HTTP callback 指令。
 * Claude 通过 --mcp-config 原生支持 MCP，不需要注入。
 *
 * Skills-as-source-of-truth: Full API docs live in
 *   cat-cafe-skills/refs/mcp-callbacks.md
 * Prompt injection is minimal: credentials + tool list + skill reference.
 * HTTP endpoints preserved as fallback only.
 */

export interface McpCallbackOptions {
  /**
   * Example unique handle to show in documentation snippets.
   * Must be routable (e.g. `@codex`, `@opus-45`), not a placeholder like `@catId`.
   */
  exampleHandle?: string;
  /**
   * Current cat id for choosing a non-self @mention example.
   * When present with teammates, we will prefer a teammate handle in examples.
   */
  currentCatId?: string;
  /**
   * Teammate cat ids that are safe to demonstrate in @mention examples.
   * Should NOT include the current cat id; if it does, it will be ignored.
   */
  teammates?: readonly string[];
}

/**
 * Providers that CANNOT receive a native MCP bridge on the spawn command line,
 * so Clowder must fall back to HTTP callback instruction injection.
 *
 * - cursor: `cursor-agent` has no `--mcp-config`; MCP is only configurable via
 *   `.cursor/mcp.json` + `agent mcp login/enable` (see `cursor-agent --help`).
 *   `--approve-mcps` only auto-approves; it does not wire the cat-cafe server.
 *   Previously this function returned true unconditionally, so when a Cursor cat
 *   had `mcpSupport=true` the caller treated MCP as "available" and SKIPPED the
 *   HTTP fallback — leaving the cat with no collaboration tools at all.
 */
const CLIENTS_WITHOUT_NATIVE_MCP_BRIDGE: ReadonlySet<string> = new Set(['cursor']);

/**
 * Whether Clowder wires native MCP into this provider's runtime invocation.
 *
 * Subprocess providers that accept an inline MCP config (claude `--mcp-config`,
 * codex `--config mcp_servers.*`) or an ACP MCP whitelist (kiro/gemini) get a
 * deterministic native bridge when the catalog marks MCP support and the server
 * entry exists. Providers in CLIENTS_WITHOUT_NATIVE_MCP_BRIDGE do not, and must
 * use the HTTP callback fallback (`needsMcpInjection`).
 */
export function hasRuntimeNativeMcpBridge(clientId?: string): boolean {
  if (clientId && CLIENTS_WITHOUT_NATIVE_MCP_BRIDGE.has(clientId)) return false;
  return true;
}

/**
 * Check if a cat needs MCP prompt injection (HTTP callback fallback).
 *
 * F041: Now checks if MCP is *actually available* (config + server path exist),
 * not just the mcpSupport config flag. HTTP callback injection acts as
 * fallback when native MCP is unavailable for any reason.
 *
 * @param mcpAvailable - true when native MCP is configured AND server path exists
 * @param clientId - provider clientId; 'antigravity' skips injection (LS persistent process can't receive callback env)
 */
export function needsMcpInjection(mcpAvailable: boolean, clientId?: string): boolean {
  if (clientId === 'antigravity') return false;
  return !mcpAvailable;
}

function resolveExampleHandle(opts: McpCallbackOptions): string {
  return (
    opts.exampleHandle ??
    (() => {
      const teammate = opts.teammates?.find((id) => id && id !== opts.currentCatId);
      return teammate ? `@${teammate}` : '@opus';
    })()
  );
}

/**
 * Build MCP callback instructions for prompt injection.
 * Minimal: @teammate rules + credentials + tool list + skill reference.
 * Full API docs are in cat-cafe-skills/refs/mcp-callbacks.md.
 */
export function buildMcpCallbackInstructions(opts: McpCallbackOptions): string {
  const exampleHandle = resolveExampleHandle(opts);
  return `## 协作方式
@队友: 独占一行写唯一句柄（如 \`${exampleHandle}\`）+动作；勿为 @ 调 post-message。
凭证: \`$CAT_CAFE_INVOCATION_ID\` + \`$CAT_CAFE_CALLBACK_TOKEN\`
工具: post-progress/post-message/register-pr-tracking/check-inbox/thread-context/fetch-thread-history/message-search/list-threads/feat-index/list-tasks/pending-mentions/create-task/claim-task/update-task/create-rich-block/search-evidence/reflect/retain-memory/request-permission/submit-game-action
跨 thread: cross-post-message + \`threadId\`
检索: [Inbox]→check-inbox→thread-context(\`keyword\`/\`catId\`)或 fetch-thread-history；跨历史 message-search(\`q\`)；feature 用 feat-index。
文档: \`$CAT_CAFE_API_URL/api/callbacks/instructions\`
富消息: \`$CAT_CAFE_API_URL/api/callbacks/rich-block-rules\``;
}
