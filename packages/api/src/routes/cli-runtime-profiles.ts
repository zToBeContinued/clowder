import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { catRegistry } from '@cat-cafe/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { resolveCatCatalogPath } from '../config/cat-catalog-store.js';
import {
  createCliRuntimeProfile,
  deleteCliRuntimeProfile,
  getCliRuntimeProfile,
  listCliRuntimeProfiles,
  patchCliRuntimeProfile,
  resolveCliRuntimeProfilesPath,
  toCliRuntimeProfileView,
} from '../config/cli-runtime-profile-store.js';
import { configEventBus, createChangeSetId } from '../config/config-event-bus.js';
import { resolveActiveProjectRoot } from '../utils/active-project-root.js';
import { resolveHeaderUserId } from '../utils/request-identity.js';

const envKeySchema = z
  .string()
  .regex(/^[A-Z_][A-Za-z0-9_]*$/, 'env key must match [A-Z_][A-Za-z0-9_]*')
  .refine((key) => !key.startsWith('CAT_CAFE_'), 'CAT_CAFE_ env keys are reserved');
const envSetSchema = z.record(envKeySchema, z.string());
const profileIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);

const createSchema = z.object({
  id: profileIdSchema.optional(),
  displayName: z.string().trim().min(1).max(120),
  command: z.string().optional(),
  envSet: envSetSchema.optional(),
});

const patchSchema = z
  .object({
    displayName: z.string().trim().min(1).max(120).optional(),
    command: z.string().nullable().optional(),
    envSet: envSetSchema.optional(),
    envRemove: z.array(envKeySchema).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'patch must not be empty');

function requireIdentity(request: Parameters<typeof resolveHeaderUserId>[0], reply: { status(code: number): unknown }) {
  const operator = resolveHeaderUserId(request);
  if (!operator) reply.status(401);
  return operator;
}

function findReferencedMemberIds(profileId: string): string[] {
  const memberIds = new Set<string>();
  for (const [memberId, config] of Object.entries(catRegistry.getAllConfigs())) {
    if (config.cliRuntimeProfileRef === profileId) memberIds.add(memberId);
  }

  const catalogPath = resolveCatCatalogPath(resolveActiveProjectRoot());
  if (!existsSync(catalogPath)) return [...memberIds].sort();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(catalogPath, 'utf-8'));
  } catch (error) {
    throw new Error(`cannot verify CLI runtime profile references in ${catalogPath}: ${(error as Error).message}`);
  }
  const breeds =
    parsed && typeof parsed === 'object' && Array.isArray((parsed as { breeds?: unknown }).breeds)
      ? ((parsed as { breeds: unknown[] }).breeds as Array<Record<string, unknown>>)
      : [];
  for (const breed of breeds) {
    const variants = Array.isArray(breed.variants) ? (breed.variants as Array<Record<string, unknown>>) : [];
    for (const variant of variants) {
      if (variant.cliRuntimeProfileRef !== profileId) continue;
      const memberId = typeof variant.catId === 'string' ? variant.catId : breed.catId;
      if (typeof memberId === 'string' && memberId) memberIds.add(memberId);
    }
  }
  return [...memberIds].sort();
}

async function emitProfileChange(profileId: string): Promise<void> {
  await configEventBus.emitChangeAsync({
    source: 'cli-runtime-profiles',
    scope: 'key',
    changedKeys: [profileId],
    changeSetId: createChangeSetId(),
    timestamp: Date.now(),
  });
}

export const cliRuntimeProfilesRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/cli-runtime-profiles', async (request, reply) => {
    const operator = requireIdentity(request, reply);
    if (!operator) return { error: 'Identity required (X-Cat-Cafe-User header)' };
    try {
      return {
        configRoot: dirname(resolveCliRuntimeProfilesPath()),
        profiles: listCliRuntimeProfiles().map(toCliRuntimeProfileView),
      };
    } catch (error) {
      reply.status(500);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.post('/api/cli-runtime-profiles', async (request, reply) => {
    const operator = requireIdentity(request, reply);
    if (!operator) return { error: 'Identity required (X-Cat-Cafe-User header)' };
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request', details: parsed.error.issues };
    }
    try {
      const profile = createCliRuntimeProfile(parsed.data);
      await emitProfileChange(profile.id);
      reply.status(201);
      return { profile: toCliRuntimeProfileView(profile), updatedBy: operator };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.status(/already exists/i.test(message) ? 409 : 400);
      return { error: message };
    }
  });

  app.patch<{ Params: { id: string } }>('/api/cli-runtime-profiles/:id', async (request, reply) => {
    const operator = requireIdentity(request, reply);
    if (!operator) return { error: 'Identity required (X-Cat-Cafe-User header)' };
    const parsed = patchSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request', details: parsed.error.issues };
    }
    try {
      const profile = patchCliRuntimeProfile(request.params.id, parsed.data);
      await emitProfileChange(profile.id);
      return { profile: toCliRuntimeProfileView(profile), updatedBy: operator };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.status(/not found/i.test(message) ? 404 : 400);
      return { error: message };
    }
  });

  app.delete<{ Params: { id: string } }>('/api/cli-runtime-profiles/:id', async (request, reply) => {
    const operator = requireIdentity(request, reply);
    if (!operator) return { error: 'Identity required (X-Cat-Cafe-User header)' };
    try {
      if (!getCliRuntimeProfile(request.params.id)) {
        reply.status(404);
        return { error: `CLI runtime profile "${request.params.id}" not found` };
      }
      const memberIds = findReferencedMemberIds(request.params.id);
      if (memberIds.length > 0) {
        reply.status(409);
        return {
          error: `CLI runtime profile "${request.params.id}" is referenced by members`,
          boundCatIds: memberIds,
        };
      }
      deleteCliRuntimeProfile(request.params.id);
      await emitProfileChange(request.params.id);
      return { deleted: true, id: request.params.id, updatedBy: operator };
    } catch (error) {
      reply.status(500);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });
};
