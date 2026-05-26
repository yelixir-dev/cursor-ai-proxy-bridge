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

  it('normalizes OpenAI text content-part arrays before backend completion', async () => {
    const server = await app({ apiKey: 'test-bridge-key' });
    const res = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer test-bridge-key' },
      payload: {
        model: 'cursor-fast',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'hello' },
              { type: 'text', text: 'world' },
            ],
          },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.choices[0].message.content).toContain('hello\nworld');
  });

  it('normalizes defensive content block shapes and image placeholders', async () => {
    const server = await app({ apiKey: 'test-bridge-key' });
    const res = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer test-bridge-key' },
      payload: {
        model: 'cursor-fast',
        messages: [
          {
            role: 'user',
            content: [
              'plain block',
              { text: 'text field' },
              { content: 'content field' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
            ],
          },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.choices[0].message.content).toContain(
      'plain block\ntext field\ncontent field\n[image omitted: cursor composer bridge is text-only]',
    );
  });

  it('streams normalized OpenAI content-part arrays when stream=true', async () => {
    const server = await app({ apiKey: 'test-bridge-key' });
    const res = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'x-api-key': 'test-bridge-key' },
      payload: {
        model: 'cursor-fast',
        stream: true,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello stream array' }] }],
      },
    });

    expect(res.statusCode).toBe(200);
    const chunks = res.body
      .split('\n\n')
      .filter((line) => line.startsWith('data: {'))
      .map(
        (line) =>
          JSON.parse(line.slice('data: '.length)) as {
            choices: Array<{ delta: { content?: string } }>;
          },
      );
    const streamedText = chunks.map((chunk) => chunk.choices[0]?.delta.content ?? '').join('');
    expect(streamedText).toContain('hello stream array');
    expect(res.body.trim().endsWith('data: [DONE]')).toBe(true);
  });

  it('streams OpenAI-compatible chat completion chunks when stream=true', async () => {
    const server = await app();
    const res = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'x-api-key': 'sk-test-client' },
      payload: {
        model: 'cursor-fast',
        stream: true,
        messages: [{ role: 'user', content: 'hello stream' }],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-type'])).toContain('text/event-stream');
    expect(res.body).toContain('data: ');
    expect(res.body).toContain('"object":"chat.completion.chunk"');
    expect(res.body).toContain('"delta":{"role":"assistant"}');
    expect(res.body.trim().endsWith('data: [DONE]')).toBe(true);

    const chunks = res.body
      .split('\n\n')
      .filter((line) => line.startsWith('data: {'))
      .map(
        (line) =>
          JSON.parse(line.slice('data: '.length)) as {
            choices: Array<{ delta: { content?: string } }>;
          },
      );
    const streamedText = chunks.map((chunk) => chunk.choices[0]?.delta.content ?? '').join('');
    expect(streamedText).toContain('mock cursor response');
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
