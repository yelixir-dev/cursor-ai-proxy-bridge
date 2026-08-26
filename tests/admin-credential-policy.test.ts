import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CursorCredentialRouter } from '../src/backend/cursor-api/credentials.js';
import { CursorApiHttpError } from '../src/backend/cursor-api/transport.js';
import type { ChatCompletionRequest, CursorBackend } from '../src/backend/types.js';
import type { BridgeConfig } from '../src/config.js';
import { readDashboardConfigFile } from '../src/dashboard-config.js';
import { buildServer } from '../src/server.js';

const headers = { authorization: 'Bearer test-admin-key' };
const credentials = [
  {
    id: 'primary',
    apiKey: 'primary-test-key',
    weight: 99,
    enabled: true,
    plan: 'ultra' as const,
    capabilities: { fable: true },
  },
  {
    id: 'secondary',
    apiKey: 'secondary-test-key',
    weight: 1,
    enabled: true,
    plan: 'pro_plus' as const,
  },
];

const request = (content: string) => ({
  method: 'POST' as const,
  url: '/v1/chat/completions',
  headers,
  payload: {
    model: 'composer-2.5',
    messages: [{ role: 'user', content }],
  },
});

describe('admin credential policy', () => {
  it('reads, persists, and hot-applies routing and failover policy', async () => {
    const configPath = join(mkdtempSync(join(tmpdir(), 'cursor-policy-')), 'dashboard.json');
    const router = new CursorCredentialRouter({ credentials });
    const attempts: string[] = [];
    const backend: CursorBackend = {
      type: 'cursor-api',
      health: async () => ({ ok: true, type: 'cursor-api', authConfigured: true }),
      listModels: async () => [
        { id: 'composer-2.5', object: 'model', created: 1, owned_by: 'cursor' },
      ],
      complete: async (completion: ChatCompletionRequest) =>
        router.route(async (credential) => {
          attempts.push(credential.id);
          if (completion.messages.at(-1)?.content === 'failover' && credential.id === 'primary') {
            throw new CursorApiHttpError(503, 'unavailable');
          }
          return { content: credential.id, model: completion.model };
        }),
      completeStream: async function* () {
        yield {
          type: 'done' as const,
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          is_error: false,
        };
      },
      credentialStates: () => router.snapshot(),
      credentialPolicy: () => router.policy(),
      updateCredentials: (nextCredentials) => router.replaceCredentials(nextCredentials),
      updateCredentialPolicy: (policy) => router.updatePolicy(policy),
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
      dashboardConfig: { credentials },
      cursorApiCredentials: credentials,
    };
    const server = await buildServer({ config, backend });

    const before = await server.inject({ method: 'GET', url: '/admin/config', headers });
    expect(before.json().config.credentialPolicy).toEqual({
      routingPolicy: 'weighted_round_robin',
      failoverOn: 'auth',
    });

    const patched = await server.inject({
      method: 'PATCH',
      url: '/admin/config',
      headers,
      payload: {
        credentialPolicy: {
          routingPolicy: 'round_robin',
          failoverOn: 'auth_or_quota_or_5xx',
        },
      },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().config.credentialPolicy).toEqual({
      routingPolicy: 'round_robin',
      failoverOn: 'auth_or_quota_or_5xx',
    });
    expect(readDashboardConfigFile(configPath).credentialPolicy).toEqual(
      patched.json().config.credentialPolicy,
    );

    const routed: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const response = await server.inject(request(`request-${index}`));
      routed.push(response.json().choices[0].message.content);
    }
    expect(routed).toEqual(['primary', 'secondary', 'primary', 'secondary']);

    const failoverAttemptStart = attempts.length;
    const failedOver = await server.inject(request('failover'));
    expect(failedOver.statusCode).toBe(200);
    expect(failedOver.json().choices[0].message.content).toBe('secondary');
    expect(attempts.slice(failoverAttemptStart)).toEqual(['primary', 'secondary']);
    await server.close();
  });

  it('rejects unsupported policy names and renders machine-addressable controls', async () => {
    const configPath = join(mkdtempSync(join(tmpdir(), 'cursor-policy-ui-')), 'dashboard.json');
    const router = new CursorCredentialRouter({ credentials });
    const backend: CursorBackend = {
      type: 'cursor-api',
      health: async () => ({ ok: true, type: 'cursor-api', authConfigured: true }),
      listModels: async () => [],
      complete: async (completion) => ({ content: 'ok', model: completion.model }),
      completeStream: async function* () {
        yield {
          type: 'done' as const,
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          is_error: false,
        };
      },
      credentialStates: () => router.snapshot(),
      credentialPolicy: () => router.policy(),
      updateCredentials: (nextCredentials) => router.replaceCredentials(nextCredentials),
      updateCredentialPolicy: (policy) => router.updatePolicy(policy),
    };
    const server = await buildServer({
      config: {
        host: '127.0.0.1',
        port: 9997,
        apiKey: 'test-admin-key',
        clientAuth: 'on',
        backend: 'cursor-api',
        defaultModel: 'composer-2.5',
        workspaceMode: 'chat-only',
        version: 'test',
        dashboardConfigPath: configPath,
        dashboardConfig: { credentials },
        cursorApiCredentials: credentials,
      },
      backend,
    });

    const invalid = await server.inject({
      method: 'PATCH',
      url: '/admin/config',
      headers,
      payload: { credentialPolicy: { routingPolicy: 'drain_first' } },
    });
    expect(invalid.statusCode).toBe(400);

    const dashboard = await server.inject({ method: 'GET', url: '/dashboard' });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.body).toContain('id="credentialRoutingPolicy"');
    expect(dashboard.body).toContain('id="credentialFailoverPolicy"');
    expect(dashboard.body).toContain('id="credentialWeightHeading"');
    expect(dashboard.body).toContain('id="credentialWeightPolicyNote"');
    expect(dashboard.body).toContain('id="credentialUsageList"');
    expect(dashboard.body).toContain('id="refreshCredentialUsage"');
    expect(dashboard.body).toContain('value="ultra_last"');
    expect(dashboard.body).toContain('id="credentialPlan"');
    expect(dashboard.body).toContain('data-credential-requirement');
    expect(dashboard.body).toContain('/admin/credentials/usage');
    expect(dashboard.body).toContain('function renderCredentialUsage');
    await server.close();
  });
});
