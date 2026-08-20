import { describe, expect, it } from 'vitest';
import type { CursorBackend } from '../src/backend/types.js';
import type { BridgeConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';

const config: BridgeConfig = {
  host: '127.0.0.1',
  port: 0,
  apiKey: 'client-secret',
  clientAuth: 'on',
  backend: 'cursor-api',
  defaultModel: 'composer-2.5',
  workspaceMode: 'chat-only',
  version: 'test',
};

const backend: CursorBackend = {
  type: 'cursor-api',
  health: async () => ({ ok: true, type: 'cursor-api', authConfigured: true }),
  listModels: async () => [],
  complete: async (request) => ({ content: 'unused', model: request.model }),
  completeStream: async function* () {
    yield {
      type: 'done',
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      is_error: false,
    };
  },
  credentialStates: () => [
    {
      id: 'personal-account',
      label: 'private@example.test',
      enabled: true,
      inFlight: 2,
      disabledUntil: 123_456,
      routerPicks: 9,
    },
  ],
};

describe('server health security boundary', () => {
  it('keeps credential inventory behind management auth when health is public', async () => {
    // Given
    const server = await buildServer({ config, backend });

    // When
    const publicHealth = await server.inject({ method: 'GET', url: '/health' });
    const unauthenticatedManagement = await server.inject({ method: 'GET', url: '/admin/config' });
    const authenticatedManagement = await server.inject({
      method: 'GET',
      url: '/admin/config',
      headers: { authorization: 'Bearer client-secret' },
    });
    await server.close();

    // Then
    expect(publicHealth.statusCode).toBe(200);
    expect(publicHealth.json()).not.toHaveProperty('credentials');
    expect(JSON.stringify(publicHealth.json())).not.toContain('private@example.test');
    expect(unauthenticatedManagement.statusCode).toBe(401);
    expect(authenticatedManagement.statusCode).toBe(200);
    expect(authenticatedManagement.json().state.credentials).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'personal-account', routerPicks: 9 })]),
    );
  });
});
