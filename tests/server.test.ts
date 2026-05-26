import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import { createMockBackend } from '../src/backend/mock.js';
import type { BridgeConfig } from '../src/config.js';

const baseConfig: BridgeConfig = {
  host: '127.0.0.1',
  port: 9994,
  apiKey: 'sk-test-client',
  backend: 'mock',
  defaultModel: 'cursor-fast',
  workspaceMode: 'chat-only',
  realWorkspacePath: undefined,
  version: '0.1.0',
};

async function app(overrides: Partial<BridgeConfig> = {}) {
  const server = await buildServer({
    config: { ...baseConfig, ...overrides },
    backend: createMockBackend(),
  });
  return server;
}

describe('cursor-ai-bridge server', () => {
  it('exposes redacted health without secrets', async () => {
    const server = await app();
    const res = await server.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.auth.client_api_key_configured).toBe(true);
    expect(JSON.stringify(body)).not.toContain('sk-test-client');
    expect(body.workspace.mode).toBe('chat-only');
  });

  it('requires client API key for /v1/models', async () => {
    const server = await app();
    const missing = await server.inject({ method: 'GET', url: '/v1/models' });
    expect(missing.statusCode).toBe(401);

    const ok = await server.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: 'Bearer sk-test-client' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.map((m: { id: string }) => m.id)).toContain('cursor-fast');
  });

  it('requires configured client API key for /v1/models', async () => {
    const server = await app({ apiKey: undefined });
    const res = await server.inject({ method: 'GET', url: '/v1/models' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.type).toBe('configuration_error');
  });

  it('accepts x-api-key auth for /v1/models', async () => {
    const server = await app();
    const ok = await server.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { 'x-api-key': 'sk-test-client' },
    });
    expect(ok.statusCode).toBe(200);
  });

  it('validates chat completion requests and returns OpenAI-compatible shape', async () => {
    const server = await app();
    const invalid = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer sk-test-client' },
      payload: { model: 'cursor-fast', messages: [] },
    });
    expect(invalid.statusCode).toBe(400);

    const ok = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer sk-test-client' },
      payload: {
        model: 'cursor-fast',
        stream: false,
        messages: [{ role: 'user', content: 'hello' }],
      },
    });
    expect(ok.statusCode).toBe(200);
    const body = ok.json();
    expect(body.object).toBe('chat.completion');
    expect(body.choices[0].message.role).toBe('assistant');
    expect(body.choices[0].message.content).toContain('mock cursor response');
  });

  it('serves a mobile-friendly read-only dashboard without key input UI or secrets', async () => {
    const server = await app();
    const res = await server.inject({ method: 'GET', url: '/dashboard' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toContain('no-store');
    const html = res.body;
    expect(html).toContain('Cursor AI Bridge Console');
    expect(html).toContain('Workspace Safety');
    expect(html).toContain('chat-only');
    expect(html).not.toContain('sk-test-client');
    expect(html).not.toMatch(/<input[^>]+(api|key|token)/i);
  });

  it('sets CSP for http dashboard fetches without upgrade-insecure-requests', async () => {
    const server = await app();
    const res = await server.inject({ method: 'GET', url: '/dashboard' });
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("connect-src 'self' http:");
    expect(csp).not.toContain('upgrade-insecure-requests');
  });
});
