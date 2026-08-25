import { describe, expect, it } from 'vitest';
import { createMockBackend } from '../src/backend/mock.js';
import type { BridgeConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';

const config: BridgeConfig = {
  host: '127.0.0.1',
  port: 0,
  clientAuth: 'off',
  backend: 'mock',
  defaultModel: 'composer-2.5',
  workspaceMode: 'chat-only',
  version: 'test',
};

describe('model context API metadata', () => {
  it('serves OpenAI-compatible context fields for curated models', async () => {
    const server = await buildServer({ config, backend: createMockBackend() });
    try {
      const response = await server.inject({ method: 'GET', url: '/v1/models' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        object: 'list',
        data: [
          {
            id: 'composer-2.5',
            object: 'model',
            created: 1_700_000_000,
            owned_by: 'cursor',
            context_window: 200_000,
            context_length: 200_000,
            max_context_length: 200_000,
          },
          {
            id: 'auto',
            object: 'model',
            created: 1_700_000_000,
            owned_by: 'cursor',
            context_window: 200_000,
            context_length: 200_000,
            max_context_length: 200_000,
          },
        ],
      });
    } finally {
      await server.close();
    }
  });
});
