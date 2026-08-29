import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BridgeModel, CursorBackend, ModelVariantView } from '../src/backend/types.js';
import type { BridgeConfig } from '../src/config.js';
import { readDashboardConfigFile } from '../src/dashboard-config.js';
import { buildServer } from '../src/server.js';

const headers = { authorization: 'Bearer test-admin-key' };

function config(configPath: string, maxModeDefault: boolean): BridgeConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    apiKey: 'test-admin-key',
    clientAuth: 'on',
    backend: 'cursor-api',
    defaultModel: 'composer-2.5',
    workspaceMode: 'chat-only',
    version: 'test',
    maxModeDefault,
    dashboardConfigPath: configPath,
    dashboardConfig: { modelOverrides: { 'sonnet-5': true, 'kimi-k3': true } },
  };
}

/**
 * Cursor publishes sonnet-5 as both a standard and a max variant, and kimi-k3
 * with no max variant at all.
 */
function maxModeBackend(initial: boolean): CursorBackend & { enabled: () => boolean } {
  let enabled = initial;
  const models = (): BridgeModel[] => [
    {
      id: 'sonnet-5',
      object: 'model',
      created: 1,
      owned_by: 'cursor',
      is_max_mode: enabled,
      context_window: enabled ? 1_000_000 : 300_000,
      context_length: enabled ? 1_000_000 : 300_000,
      max_context_length: enabled ? 1_000_000 : 300_000,
    },
    {
      id: 'kimi-k3',
      object: 'model',
      created: 1,
      owned_by: 'cursor',
      is_max_mode: false,
      context_window: 200_000,
      context_length: 200_000,
      max_context_length: 200_000,
    },
  ];
  return {
    type: 'cursor-api',
    enabled: () => enabled,
    health: async () => ({ ok: true, type: 'cursor-api', authConfigured: true }),
    listModels: async () => models(),
    complete: async (request) => ({ content: 'ok', model: request.model }),
    completeStream: async function* () {
      yield {
        type: 'done' as const,
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        is_error: false,
      };
    },
    maxModeDefault: () => enabled,
    updateMaxMode: (next: boolean) => {
      enabled = next;
    },
    modelVariants: (): ModelVariantView[] => [
      {
        id: 'sonnet-5',
        resolvedVariant: enabled ? 'claude-sonnet-5-medium' : 'claude-sonnet-5-medium',
        isMaxMode: enabled,
        contextWindow: enabled ? 1_000_000 : 300_000,
      },
      {
        id: 'kimi-k3',
        resolvedVariant: 'kimi-k3-high',
        isMaxMode: false,
        contextWindow: 200_000,
      },
    ],
  };
}

describe('admin Max Mode policy', () => {
  it('reports and hot-applies the Max Mode default without a restart', async () => {
    // Given: a bridge started with Max Mode off.
    const configPath = join(mkdtempSync(join(tmpdir(), 'cursor-max-mode-')), 'dashboard.json');
    const backend = maxModeBackend(false);
    const server = await buildServer({ config: config(configPath, false), backend });
    try {
      const before = await server.inject({ method: 'GET', url: '/admin/config', headers });
      expect(before.json().config.maxModeDefault).toBe(false);
      expect(
        before.json().state.models.find((model: { id: string }) => model.id === 'sonnet-5'),
      ).toMatchObject({ isMaxMode: false, contextWindow: 300_000 });

      // When: the dashboard turns the policy on.
      const patched = await server.inject({
        method: 'PATCH',
        url: '/admin/config',
        headers,
        payload: { maxModeDefault: true },
      });

      // Then: the response, the backend, and the persisted config all agree.
      expect(patched.statusCode).toBe(200);
      expect(patched.json().config.maxModeDefault).toBe(true);
      expect(backend.enabled()).toBe(true);
      expect(readDashboardConfigFile(configPath).maxModeDefault).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('advertises the selected variant window and distinguishes max from standard', async () => {
    // Given: a bridge started with Max Mode already on.
    const configPath = join(mkdtempSync(join(tmpdir(), 'cursor-max-mode-on-')), 'dashboard.json');
    const server = await buildServer({
      config: config(configPath, true),
      backend: maxModeBackend(true),
    });
    try {
      // When: an OpenAI client reads the model catalogue.
      const response = await server.inject({ method: 'GET', url: '/v1/models', headers });
      const data = response.json().data as Array<Record<string, unknown>>;

      // Then: the max family reports its 1M window and the flag, while the
      // family without a max variant keeps its standard window.
      expect(data.find((model) => model.id === 'sonnet-5')).toMatchObject({
        is_max_mode: true,
        context_window: 1_000_000,
        max_context_length: 1_000_000,
      });
      expect(data.find((model) => model.id === 'kimi-k3')).toMatchObject({
        is_max_mode: false,
        context_window: 200_000,
      });
    } finally {
      await server.close();
    }
  });
});
