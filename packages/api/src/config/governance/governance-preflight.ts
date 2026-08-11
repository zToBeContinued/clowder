/**
 * F070: Governance Preflight Gate
 *
 * Checks if an external project is ready for cat dispatch.
 * Returns actionable state (needsBootstrap / needsConfirmation)
 * so the caller can surface instructions instead of silently blocking.
 * Fixes: clowder-ai#123 (preflight blocks new projects without guidance)
 *
 * Since pack 2.0.0 (state-only write mode), readiness is a pure registry
 * check: no instruction files, managed blocks or skill symlinks are required
 * in the project tree. Cats receive governance and skills at runtime
 * (system prompt + `cat_cafe_read_skill` MCP tools), so their absence on
 * disk must not block dispatch — requiring them was what forced every
 * external project to carry Cat Cafe footprint.
 */
import { isSameProject } from '../../utils/monorepo-root.js';
import { GovernanceRegistry } from './governance-registry.js';

export interface PreflightResult {
  ready: boolean;
  reason?: string;
  needsBootstrap?: boolean;
  needsConfirmation?: boolean;
  needsPermission?: boolean;
  bootstrapCommand?: string;
}

export async function checkGovernancePreflight(
  projectPath: string,
  catCafeRoot: string,
  _catProvider?: string,
): Promise<PreflightResult> {
  if (isSameProject(projectPath, catCafeRoot)) {
    return { ready: true };
  }

  const registry = new GovernanceRegistry(catCafeRoot);
  const entry = await registry.get(projectPath);

  if (!entry) {
    return {
      ready: false,
      needsBootstrap: true,
      reason: `Governance not bootstrapped for ${projectPath}. Use POST /api/governance/confirm to bootstrap.`,
      bootstrapCommand: `POST /api/governance/confirm { "projectPath": "${projectPath}" }`,
    };
  }

  if (!entry.confirmedByUser) {
    return {
      ready: false,
      needsConfirmation: true,
      reason: `Governance bootstrap pending confirmation for ${projectPath}.`,
      bootstrapCommand: `POST /api/governance/confirm { "projectPath": "${projectPath}" }`,
    };
  }

  return { ready: true };
}
