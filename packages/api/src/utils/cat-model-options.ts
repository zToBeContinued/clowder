import type { ClientId } from '@cat-cafe/shared';
import { getLocalCliModelsSnapshot } from './local-cli-model-cache.js';
import { LOCAL_CLI_MODELS_PROBES, type LocalCliModelSource } from './local-cli-model-probes.js';

interface CatModelOptionPreset {
  readonly defaultModel: string;
  readonly models: readonly string[];
}

export interface CatModelOptionClient {
  readonly defaultModel: string;
  readonly models: string[];
  readonly modelsSource: LocalCliModelSource;
}

const STATIC_PRESETS: Partial<Record<ClientId, CatModelOptionPreset>> = {
  anthropic: { defaultModel: 'claude-sonnet-5', models: LOCAL_CLI_MODELS_PROBES.claude.static ?? [] },
  openai: { defaultModel: 'gpt-5.6-sol', models: LOCAL_CLI_MODELS_PROBES.codex.static ?? [] },
  google: { defaultModel: 'gemini-3.1-pro-preview', models: LOCAL_CLI_MODELS_PROBES.gemini.static ?? [] },
  kimi: { defaultModel: 'kimi-code/kimi-for-coding', models: LOCAL_CLI_MODELS_PROBES.kimi.static ?? [] },
  grok: { defaultModel: 'grok-4.5', models: LOCAL_CLI_MODELS_PROBES.grok.static ?? [] },
  opencode: { defaultModel: 'xiaomi-mimo/mimo-v2.5-pro', models: LOCAL_CLI_MODELS_PROBES.opencode.static ?? [] },
  dare: { defaultModel: 'claude-fable-5', models: ['claude-fable-5'] },
  // Kiro 模型由本机 Kiro CLI 的 settings 决定，因人而异；这里给一份保守兜底，
  // 本机 CLI 扫描（LOCAL_CLI_MODELS_PROBES.kiro，读 `kiro-cli settings list`）会覆盖为真实列表。
  kiro: {
    defaultModel: 'gpt-5.6-sol',
    models:
      LOCAL_CLI_MODELS_PROBES.kiro.static && LOCAL_CLI_MODELS_PROBES.kiro.static.length > 0
        ? LOCAL_CLI_MODELS_PROBES.kiro.static
        : ['gpt-5.6-sol', 'claude-opus-4.8'],
  },
  // Cursor 模型由本机 cursor-agent 账号决定，且 effort 编码在模型名后缀里（-high/-xhigh/-max）。
  // 给一份真实有效的变体兜底；本机扫描(`cursor-agent models`)会覆盖为账号完整列表。
  cursor: {
    defaultModel: 'auto',
    models:
      LOCAL_CLI_MODELS_PROBES.cursor?.static && LOCAL_CLI_MODELS_PROBES.cursor.static.length > 0
        ? LOCAL_CLI_MODELS_PROBES.cursor.static
        : [
            'auto',
            'claude-opus-4-8-high',
            'claude-opus-4-8-xhigh',
            'claude-opus-4-8-max',
            'gpt-5.6-sol-high',
            'gpt-5.6-sol-xhigh',
            'gpt-5.3-codex-high',
            'gpt-5.3-codex-xhigh',
          ],
  },
  pi: {
    defaultModel: 'mimo/mimo-v2.5-pro',
    models: ['mimo/mimo-v2.5-pro', 'mimo/mimo-v2.5', 'xiaomi/mimo-v2.5-pro', 'openrouter/auto'],
  },
};

function uniqueModels(models: readonly string[]): string[] {
  return [...new Set(models.map((model) => model.trim()).filter(Boolean))];
}

function staticClients(): Partial<Record<ClientId, CatModelOptionClient>> {
  return Object.fromEntries(
    Object.entries(STATIC_PRESETS).map(([clientId, preset]) => [
      clientId,
      {
        defaultModel: preset.defaultModel,
        models: uniqueModels(preset.models),
        modelsSource: 'static',
      },
    ]),
  ) as Partial<Record<ClientId, CatModelOptionClient>>;
}

export function getCatModelOptionsResponse(userId: string): {
  source: 'static-presets-v1' | 'local-cli-scan-v1';
  scannedAt?: string;
  clients: Partial<Record<ClientId, CatModelOptionClient>>;
} {
  const snapshot = getLocalCliModelsSnapshot(userId);
  const clients = staticClients();
  if (!snapshot) return { source: 'static-presets-v1', clients };

  let hasScannedModels = false;
  for (const cli of snapshot.clis) {
    if (!cli.clientId) continue;
    const scannedCandidates = cli.models.filter((model) => model.source === 'cli' || model.source === 'config');
    const models = uniqueModels(scannedCandidates.map((model) => model.id));
    if (models.length === 0) continue;
    hasScannedModels = true;
    const staticPreset = clients[cli.clientId];
    const scannedDefault = scannedCandidates.find((model) => model.isDefault)?.id;
    clients[cli.clientId] = {
      defaultModel:
        scannedDefault ??
        (staticPreset && models.includes(staticPreset.defaultModel) ? staticPreset.defaultModel : (models[0] ?? '')),
      models,
      modelsSource: scannedCandidates[0]?.source ?? 'static',
    };
  }

  if (!hasScannedModels) return { source: 'static-presets-v1', clients };

  return {
    source: 'local-cli-scan-v1',
    scannedAt: snapshot.scannedAt,
    clients,
  };
}
