import { describe, expect, it, vi } from 'vitest';
import type { CursorCredentialUsageView } from '../src/backend/cursor-api/account-usage.js';
import type { CursorBackend } from '../src/backend/types.js';
import type { BridgeConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';

const headers = { authorization: 'Bearer test-admin-key' };
const snapshot: CursorCredentialUsageView = {
  id: 'primary',
  label: '운영 계정',
  enabled: true,
  status: 'fresh',
  fetchedAt: 123_456,
  plan: { name: 'Ultra', price: '$200/mo', owner: 'stripe' },
  cycle: { resetsAt: 1_782_678_400_000 },
  pools: {
    cursorModels: {
      usedPercent: 4.5,
      modelIds: ['composer-2.5', 'cursor-grok-4.6'],
    },
    otherModels: { usedPercent: 28 },
  },
};

function backend(credentialUsage: CursorBackend['credentialUsage']): CursorBackend {
  return {
    type: 'cursor-api',
    health: async () => ({ ok: true, type: 'cursor-api', authConfigured: true }),
    listModels: async () => [],
    complete: async (request) => ({ content: 'ok', model: request.model }),
    completeStream: async function* () {
      yield {
        type: 'done' as const,
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        is_error: false,
      };
    },
    credentialUsage,
  };
}

const config: BridgeConfig = {
  host: '127.0.0.1',
  port: 9997,
  apiKey: 'test-admin-key',
  clientAuth: 'on',
  backend: 'cursor-api',
  defaultModel: 'composer-2.5',
  workspaceMode: 'chat-only',
  version: 'test',
};

describe('admin credential usage', () => {
  it('requires admin authentication and returns cached usage snapshots', async () => {
    const credentialUsage = vi.fn(async () => [snapshot]);
    const server = await buildServer({ config, backend: backend(credentialUsage) });

    const unauthorized = await server.inject({
      method: 'GET',
      url: '/admin/credentials/usage',
    });
    expect(unauthorized.statusCode).toBe(401);

    const response = await server.inject({
      method: 'GET',
      url: '/admin/credentials/usage',
      headers,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ credentials: [snapshot] });
    expect(credentialUsage).toHaveBeenCalledWith({ force: false });
    await server.close();
  });

  it('forces a fresh upstream read through the refresh endpoint', async () => {
    const credentialUsage = vi.fn(async () => [snapshot]);
    const server = await buildServer({ config, backend: backend(credentialUsage) });

    const response = await server.inject({
      method: 'POST',
      url: '/admin/credentials/usage/refresh',
      headers,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ credentials: [snapshot] });
    expect(credentialUsage).toHaveBeenCalledWith({ force: true });
    await server.close();
  });
});
