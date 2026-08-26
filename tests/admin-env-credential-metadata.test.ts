import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CursorCredentialRouter } from '../src/backend/cursor-api/credentials.js';
import type { CursorBackend } from '../src/backend/types.js';
import type { BridgeConfig } from '../src/config.js';
import { readDashboardConfigFile } from '../src/dashboard-config.js';
import { buildServer } from '../src/server.js';

const headers = { authorization: 'Bearer test-admin-key' };
const envApiKey = 'env-secret-must-remain-locked';

function fixture() {
  const configPath = join(mkdtempSync(join(tmpdir(), 'cursor-env-metadata-')), 'dashboard.json');
  const router = new CursorCredentialRouter({
    credentials: [{ id: 'env', apiKey: envApiKey }],
  });
  const backend: CursorBackend = {
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
    credentialStates: () => router.snapshot(),
    credentialPolicy: () => router.policy(),
    updateCredentials: (credentials) => router.replaceCredentials(credentials),
  };
  const config: BridgeConfig = {
    host: '127.0.0.1',
    port: 9997,
    apiKey: 'test-admin-key',
    clientAuth: 'on',
    backend: 'cursor-api',
    defaultModel: 'composer-2.5',
    workspaceMode: 'chat-only',
    version: 'test',
    dashboardConfigPath: configPath,
    dashboardConfig: {},
    cursorApiCredentials: [{ id: 'env', apiKey: envApiKey, weight: 1, enabled: true }],
  };
  return { configPath, router, server: buildServer({ config, backend }) };
}

describe('env credential dashboard metadata', () => {
  it('persists and hot-applies plan and capability without storing the env API key', async () => {
    const setup = fixture();
    const server = await setup.server;

    const response = await server.inject({
      method: 'PATCH',
      url: '/admin/config',
      headers,
      payload: {
        credentials: [{ id: 'env', plan: 'ultra', capabilities: { fable: true } }],
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().config.credentials).toContainEqual(
      expect.objectContaining({
        id: 'env',
        plan: 'ultra',
        capabilities: { fable: true },
      }),
    );
    expect(readDashboardConfigFile(setup.configPath)).toMatchObject({
      envCredentialMetadata: { plan: 'ultra', capabilities: { fable: true } },
    });
    expect(setup.router.credentials()).toContainEqual(
      expect.objectContaining({
        id: 'env',
        apiKey: envApiKey,
        plan: 'ultra',
        capabilities: { fable: true },
      }),
    );
    expect(JSON.stringify(readDashboardConfigFile(setup.configPath))).not.toContain(envApiKey);
    await server.close();
  });

  it('rejects attempts to replace the env API key', async () => {
    const setup = fixture();
    const server = await setup.server;

    const response = await server.inject({
      method: 'PATCH',
      url: '/admin/config',
      headers,
      payload: { credentials: [{ id: 'env', apiKey: 'dashboard-secret' }] },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('CURSOR_API_KEY');
    expect(setup.router.credentials()[0]?.apiKey).toBe(envApiKey);
    await server.close();
  });

  it('renders env plan and capability as editable while keeping secret controls locked', async () => {
    const setup = fixture();
    const server = await setup.server;

    const response = await server.inject({ method: 'GET', url: '/dashboard' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("const metadataLocked=id==='system';");
    expect(response.body).toContain('plan.disabled=metadataLocked');
    expect(response.body).toContain(
      "switchControl(config.capabilities&&config.capabilities.fable===true,metadataLocked||config.plan!=='ultra'",
    );
    expect(response.body).toContain("const secretLocked=id==='env'||id==='system';");
    await server.close();
  });
});
