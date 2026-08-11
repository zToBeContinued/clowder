/**
 * F070: Portable Governance Pack — content definitions
 *
 * Defines the managed block content that gets injected into
 * external project CLAUDE.md/AGENTS.md/GEMINI.md/KIMI.md files
 * when a project explicitly opts into on-disk governance
 * (`writeMode: 'full'`). Since pack 2.0.0 the default write mode
 * is 'state-only' and these files are not written at all.
 *
 * The block opens with a Scope Guard so that non-Clowder sessions
 * (plain Claude Code / Codex / Cursor / Kiro opened directly in the
 * project) do NOT adopt cat identity or load cat-cafe skills.
 * Clowder sessions are identified by the `CAT_CAFE_CAT_ID` env var,
 * which every Clowder-spawned agent process carries.
 *
 * Port values use internal defaults (3001/6399/6398).
 * The sync-to-opensource pipeline transforms API/frontend ports
 * to public defaults (3003/3004). Redis ports stay as-is (6399/6398).
 */
import { createHash } from 'node:crypto';

export const GOVERNANCE_PACK_VERSION = '2.0.0';

export const MANAGED_BLOCK_START = '<!-- CAT-CAFE-GOVERNANCE-START -->';
export const MANAGED_BLOCK_END = '<!-- CAT-CAFE-GOVERNANCE-END -->';

const SCOPE_GUARD = `### ⚠️ Scope Guard — read this first
- This block applies ONLY to agent sessions launched by Clowder (Cat Cafe).
- Every Clowder-launched session has the \`CAT_CAFE_CAT_ID\` environment variable set.
- If \`CAT_CAFE_CAT_ID\` is NOT set in your environment, you are NOT a Cat Cafe agent:
  **ignore this entire block**, do NOT adopt any cat identity or persona, and do NOT
  load or follow skills under \`.claude/skills\`, \`.codex/skills\`, \`.gemini/skills\`,
  \`.kimi/skills\` or \`cat-cafe-skills/\`. Treat the rest of this file (outside this
  managed block) as the only project instructions that apply to you.`;

const HARD_CONSTRAINTS = `## Cat Cafe Governance Rules (Auto-managed, Clowder sessions only)

### Hard Constraints (immutable)
- **Public local defaults**: use frontend 3003 and API 3004 to avoid colliding with another local runtime.
- **Redis port 6399** is Cat Cafe's production Redis. Never connect to it from external projects. Use 6398 for dev/test.
- **No self-review**: The same individual cannot review their own code. Cross-family review preferred.
- **Identity is constant**: Never impersonate another cat. Identity is a hard constraint.

### Collaboration Standards
- A2A handoff uses five-tuple: What / Why / Tradeoff / Open Questions / Next Action
- Vision Guardian: Read original requirements before starting. AC completion ≠ feature complete.
- Review flow: quality-gate → request-review → receive-review → merge-gate
- Skills are provided at runtime via Clowder MCP tools (\`cat_cafe_list_skills\` / \`cat_cafe_read_skill\`);
  project-level skills symlinks are optional and may be absent
- Shared rules: See cat-cafe-skills/refs/shared-rules.md (in the Cat Cafe repo) for the full collaboration contract`;

const METHODOLOGY_INTRO = `### Knowledge Engineering
- Documents use YAML frontmatter (feature_ids, topics, doc_kind, created)
- Three-layer info architecture: CLAUDE.md (≤100 lines) → Skills (on-demand) → refs/
- Backlog: BACKLOG.md (hot) → Feature files (warm) → raw docs (cold)
- Feature lifecycle: kickoff → discussion → implementation → review → completion
- SOP: See docs/SOP.md for the 6-step workflow`;

export type Provider = 'claude' | 'codex' | 'gemini' | 'kimi';

/**
 * Generate the managed block content for a specific provider.
 * This block is injected into the provider's instruction file
 * (CLAUDE.md, AGENTS.md, GEMINI.md, or KIMI.md).
 */
export function getGovernanceManagedBlock(provider: Provider): string {
  return [
    MANAGED_BLOCK_START,
    `> Pack version: ${GOVERNANCE_PACK_VERSION} | Provider: ${provider}`,
    '',
    SCOPE_GUARD,
    '',
    HARD_CONSTRAINTS,
    '',
    METHODOLOGY_INTRO,
    MANAGED_BLOCK_END,
  ].join('\n');
}

/**
 * Compute a stable checksum for the governance pack content.
 * Used for idempotency — skip re-sync if checksum matches.
 */
export function computePackChecksum(): string {
  const content = SCOPE_GUARD + HARD_CONSTRAINTS + METHODOLOGY_INTRO + GOVERNANCE_PACK_VERSION;
  return createHash('sha256').update(content).digest('hex').slice(0, 12);
}
