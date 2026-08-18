import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { buildServer, timingSafeKeyEqual } from '../src/server.js';
import { createMockBackend } from '../src/backend/mock.js';
import {
  createCursorCliBackend,
  CursorBackendError,
  type CursorSpawn,
} from '../src/backend/cursor-cli.js';
import type { CursorBackend } from '../src/backend/types.js';
import type { BridgeConfig } from '../src/config.js';
import {
  CursorCredentialRouter,
  type CursorApiCredential,
} from '../src/backend/cursor-api/credentials.js';

const baseConfig: BridgeConfig = {
  host: '127.0.0.1',
  port: 9997,
  apiKey: '***',
  clientAuth: 'on',
  backend: 'mock',
  defaultModel: 'composer-2.5',
  workspaceMode: 'chat-only',
  realWorkspacePath: undefined,
  version: '0.1.0',
};

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function app(overrides: Partial<BridgeConfig> = {}) {
  const server = await buildServer({
    config: { ...baseConfig, ...overrides },
    backend: createMockBackend(),
  });
  return server;
}

function streamingRequest(
  port: number,
  payload: unknown,
): Promise<{
  request: ReturnType<typeof httpRequest>;
  response: IncomingMessage;
}> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          authorization: 'Bearer ***',
          'content-type': 'application/json',
        },
      },
      (response) => {
        response.pause();
        resolve({ request, response });
      },
    );
    request.once('error', reject);
    request.end(JSON.stringify(payload));
  });
}

describe('cursor-ai-bridge server', () => {
  it('exposes redacted health without secrets', async () => {
    const server = await app();
    const res = await server.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.auth.client_auth_enabled).toBe(true);
    expect(body.auth.client_api_key_configured).toBe(true);
    expect(JSON.stringify(body)).not.toContain('***');
    expect(body.workspace.mode).toBe('chat-only');
  });

  it('accepts chat completions larger than 2 MiB', async () => {
    const server = await app();
    const padding = 'x'.repeat(150_000);
    const messages = Array.from({ length: 15 }, (_, index) => ({
      role: 'user' as const,
      content: `${index}:${padding}`,
    }));
    const res = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer ***' },
      payload: { model: 'composer-2.5', messages },
    });

    expect(res.statusCode).toBe(200);
    await server.close();
  });

  it('requires client API key for /v1/models', async () => {
    const server = await app();
    const missing = await server.inject({ method: 'GET', url: '/v1/models' });
    expect(missing.statusCode).toBe(401);
    const wrong = await server.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: 'Bearer wrong' },
    });
    expect(wrong.statusCode).toBe(401);

    const ok = await server.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: 'Bearer ***' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.map((m: { id: string }) => m.id)).toContain('composer-2.5');
  });

  it('defaults client auth to off when the API key is unset', async () => {
    const server = await app({ apiKey: undefined, clientAuth: undefined });
    const models = await server.inject({ method: 'GET', url: '/v1/models' });
    const admin = await server.inject({ method: 'GET', url: '/admin/config' });

    expect(models.statusCode).toBe(200);
    expect(admin.statusCode).toBe(200);
    expect((await server.inject({ method: 'GET', url: '/health' })).json().auth).toEqual({
      client_auth_enabled: false,
      client_api_key_configured: false,
    });
  });

  it('ignores absent and invalid credentials when client auth is off', async () => {
    const configPath = join(mkdtempSync(join(tmpdir(), 'cursor-auth-off-')), 'dashboard.json');
    const server = await app({
      apiKey: 'configured-key',
      clientAuth: 'off',
      dashboardConfigPath: configPath,
      dashboardConfig: {},
    });
    const models = await server.inject({ method: 'GET', url: '/v1/models' });
    const admin = await server.inject({
      method: 'GET',
      url: '/admin/config',
      headers: { authorization: 'Bearer wrong-key' },
    });
    const completion = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer wrong-key' },
      payload: { messages: [{ role: 'user', content: 'open auth' }] },
    });

    const patched = await server.inject({
      method: 'PATCH',
      url: '/admin/config',
      payload: { modelOverrides: { 'composer-2.5': false } },
    });

    expect(models.statusCode).toBe(200);
    expect(admin.statusCode).toBe(200);
    expect(completion.statusCode).toBe(200);
    expect(patched.statusCode).toBe(200);
  });

  it('rejects startup when client auth is on without an API key', async () => {
    await expect(app({ apiKey: undefined, clientAuth: 'on' })).rejects.toThrow(
      'CURSOR_BRIDGE_AUTH=on requires CURSOR_BRIDGE_API_KEY',
    );
  });

  it('accepts x-api-key auth for /v1/models', async () => {
    const server = await app();
    const ok = await server.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { 'x-api-key': '***' },
    });
    expect(ok.statusCode).toBe(200);
  });

  it('filters curated models, rejects disabled models, and hot-applies admin updates', async () => {
    const configPath = join(mkdtempSync(join(tmpdir(), 'cursor-admin-')), 'dashboard.json');
    const router = new CursorCredentialRouter({
      credentials: [{ id: 'first', apiKey: 'first-test-secret' }],
    });
    const backend: CursorBackend = {
      type: 'cursor-api',
      health: async () => ({ ok: true, type: 'cursor-api', authConfigured: true }),
      listModels: async () => [
        { id: 'composer-2.5', object: 'model', created: 1, owned_by: 'cursor' },
        { id: 'composer-latest', object: 'model', created: 1, owned_by: 'cursor' },
        { id: 'gpt-5.5-high', object: 'model', created: 1, owned_by: 'cursor' },
      ],
      complete: async (request) => {
        const credential = router.pick();
        router.release(credential.id);
        return { content: credential.id, model: request.model };
      },
      completeStream: async function* () {
        yield {
          type: 'done' as const,
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          is_error: false,
        };
      },
      credentialStates: () => router.snapshot(),
      updateCredentials: (credentials: CursorApiCredential[]) =>
        router.replaceCredentials(credentials),
    };
    const server = await buildServer({
      config: {
        ...baseConfig,
        backend: 'cursor-api',
        dashboardConfigPath: configPath,
        dashboardConfig: {},
        cursorApiCredentials: [
          { id: 'first', apiKey: 'first-test-secret', weight: 1, enabled: true },
        ],
      },
      backend,
    });
    const headers = { authorization: 'Bearer ***' };

    const modelsBefore = await server.inject({ method: 'GET', url: '/v1/models', headers });
    expect(modelsBefore.json().data.map((model: { id: string }) => model.id)).toEqual([
      'composer-2.5',
    ]);
    const disabled = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers,
      payload: {
        model: 'composer-latest',
        messages: [{ role: 'user', content: 'disabled' }],
      },
    });
    expect(disabled.statusCode).toBe(400);
    expect(disabled.json()).toEqual({
      error: { type: 'invalid_request_error', message: "model 'composer-latest' is disabled" },
    });
    const absent = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers,
      payload: {
        model: 'cursor-grok-4.6-high',
        messages: [{ role: 'user', content: 'absent' }],
      },
    });
    expect(absent.statusCode).toBe(400);
    expect(absent.json().error.message).toBe("model 'cursor-grok-4.6-high' is disabled");

    const unauthorizedAdmin = await server.inject({ method: 'GET', url: '/admin/config' });
    expect(unauthorizedAdmin.statusCode).toBe(401);
    const before = await server.inject({ method: 'GET', url: '/admin/config', headers });
    expect(before.statusCode).toBe(200);
    expect(JSON.stringify(before.json())).not.toContain('first-test-secret');
    expect(before.json().config.credentials[0].apiKeyPreview).toBe('firs…');

    const patched = await server.inject({
      method: 'PATCH',
      url: '/admin/config',
      headers,
      payload: {
        credentials: [{ id: 'second', apiKey: 'second-test-secret', weight: 10 }],
        modelOverrides: { 'composer-latest': true },
      },
    });
    expect(patched.statusCode).toBe(200);
    expect(JSON.stringify(patched.json())).not.toContain('second-test-secret');
    expect(patched.json().state.models).toContainEqual({
      id: 'composer-latest',
      enabled: true,
      source: 'override',
    });

    const modelsAfter = await server.inject({ method: 'GET', url: '/v1/models', headers });
    expect(modelsAfter.json().data.map((model: { id: string }) => model.id)).toContain(
      'composer-latest',
    );
    const completion = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers,
      payload: {
        model: 'composer-latest',
        messages: [{ role: 'user', content: 'enabled' }],
      },
    });
    expect(completion.statusCode).toBe(200);
    expect(completion.json().choices[0].message.content).toBe('second');
  });

  it('normalizes malformed /v1 JSON into an OpenAI error envelope', async () => {
    const server = await app();
    const res = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: 'Bearer ***',
        'content-type': 'application/json',
      },
      payload: '{"messages": [',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: {
        message: expect.any(String),
        type: 'invalid_request_error',
      },
    });
  });

  it('validates chat completion requests and returns OpenAI-compatible shape', async () => {
    const server = await app();
    const invalid = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer ***' },
      payload: { model: 'composer-2.5', messages: [] },
    });
    expect(invalid.statusCode).toBe(400);

    const ok = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer ***' },
      payload: {
        stream: false,
        messages: [{ role: 'user', content: 'hello' }],
      },
    });
    expect(ok.statusCode).toBe(200);
    const body = ok.json();
    expect(body.object).toBe('chat.completion');
    expect(body.model).toBe('composer-2.5');
    expect(body.choices[0].message.role).toBe('assistant');
    expect(body.choices[0].message.content).toContain('mock cursor response');
  });

  it.each([
    { label: 'omitted tools', tools: undefined },
    { label: 'empty tools', tools: [] },
  ])('rejects required tool choice with $label', async ({ tools }) => {
    const server = await app();
    const res = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer ***' },
      payload: {
        messages: [{ role: 'user', content: 'use a tool' }],
        ...(tools === undefined ? {} : { tools }),
        tool_choice: 'required',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.type).toBe('invalid_request_error');
    expect(res.json().error.message).toContain('at least one defined tool');
  });

  it('rejects a forced function that is not defined', async () => {
    const server = await app();
    const res = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer ***' },
      payload: {
        messages: [{ role: 'user', content: 'use missing' }],
        tools: [{ type: 'function', function: { name: 'available', parameters: {} } }],
        tool_choice: { type: 'function', function: { name: 'missing' } },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.type).toBe('invalid_request_error');
    expect(res.json().error.message).toContain('missing');
  });

  it('rejects duplicate tool function names', async () => {
    const server = await app();
    const res = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer ***' },
      payload: {
        messages: [{ role: 'user', content: 'use duplicate' }],
        tools: [
          { type: 'function', function: { name: 'duplicate', parameters: {} } },
          { type: 'function', function: { name: 'duplicate', parameters: {} } },
        ],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.type).toBe('invalid_request_error');
    expect(res.json().error.message).toContain('Duplicate');
  });

  it.each([
    {
      label: 'unknown tool result id',
      messages: [
        { role: 'user', content: 'start' },
        { role: 'tool', tool_call_id: 'unknown', content: 'result' },
      ],
    },
    {
      label: 'missing tool result id',
      messages: [
        { role: 'user', content: 'start' },
        { role: 'tool', content: 'result' },
      ],
    },
    {
      label: 'duplicate tool call ids',
      messages: [
        { role: 'user', content: 'start' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'duplicate_id',
              type: 'function',
              function: { name: 'one', arguments: '{}' },
            },
            {
              id: 'duplicate_id',
              type: 'function',
              function: { name: 'two', arguments: '{}' },
            },
          ],
        },
      ],
    },
    {
      label: 'tool calls on a non-assistant role',
      messages: [
        {
          role: 'user',
          content: 'start',
          tool_calls: [
            {
              id: 'call_on_user',
              type: 'function',
              function: { name: 'one', arguments: '{}' },
            },
          ],
        },
      ],
    },
    {
      label: 'assistant call without a following result',
      messages: [
        { role: 'user', content: 'start' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'missing_result',
              type: 'function',
              function: { name: 'one', arguments: '{}' },
            },
          ],
        },
      ],
    },
  ])('rejects malformed tool history: $label', async ({ messages }) => {
    const server = await app();
    const res = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer ***' },
      payload: { messages },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.type).toBe('invalid_request_error');
  });

  it('accepts developer-role messages', async () => {
    const server = await app();
    const res = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer ***' },
      payload: {
        messages: [
          { role: 'developer', content: 'follow policy' },
          { role: 'user', content: 'hello developer' },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().choices[0].message.content).toContain('hello developer');
  });

  it('normalizes OpenAI text content-part arrays before backend completion', async () => {
    const server = await app({ apiKey: 'test-bridge-key' });
    const res = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer test-bridge-key' },
      payload: {
        model: 'composer-2.5',
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
        model: 'composer-2.5',
        messages: [
          {
            role: 'user',
            content: [
              'plain block',
              { text: 'text field' },
              { content: 'content field' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
              { type: 'file', file_id: 'file_123' },
            ],
          },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.choices[0].message.content).toContain(
      'plain block\ntext field\ncontent field\n[image omitted: cursor composer bridge is text-only]\n[unsupported content type omitted: file]',
    );
  });

  it('rejects excessively large content-part arrays before normalization', async () => {
    const server = await app({ apiKey: 'test-bridge-key' });
    const res = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer test-bridge-key' },
      payload: {
        model: 'composer-2.5',
        messages: [
          {
            role: 'user',
            content: Array.from({ length: 1001 }, () => ({ type: 'text', text: 'x' })),
          },
        ],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.type).toBe('invalid_request_error');
  });

  it('streams normalized OpenAI content-part arrays when stream=true', async () => {
    const server = await app({ apiKey: 'test-bridge-key' });
    const res = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'x-api-key': 'test-bridge-key' },
      payload: {
        model: 'composer-2.5',
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
      headers: { 'x-api-key': '***' },
      payload: {
        model: 'composer-2.5',
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

  it('delivers an SSE byte before a streaming backend completes', async () => {
    const firstEvent = deferred();
    const release = deferred();
    let completed = false;
    const backend: CursorBackend = {
      ...createMockBackend(),
      async *completeStream() {
        firstEvent.resolve();
        yield { type: 'content' as const, text: 'first ' };
        await release.promise;
        yield { type: 'content' as const, text: 'second' };
        completed = true;
        yield {
          type: 'done' as const,
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
          is_error: false,
        };
      },
    };
    const server = await buildServer({ config: baseConfig, backend });
    await server.listen({ host: '127.0.0.1', port: 0 });
    const port = (server.server.address() as AddressInfo).port;
    const clientPromise = streamingRequest(port, {
      stream: true,
      messages: [{ role: 'user', content: 'incremental' }],
    });

    await firstEvent.promise;
    const { response } = await clientPromise;
    const firstByte = deferred();
    const chunks: Buffer[] = [];
    const ended = deferred();
    response.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      firstByte.resolve();
    });
    response.once('end', () => ended.resolve());
    response.resume();
    await firstByte.promise;
    expect(completed).toBe(false);

    release.resolve();
    await ended.promise;
    const body = Buffer.concat(chunks).toString('utf8');
    const text = body
      .split('\n\n')
      .filter((frame) => frame.startsWith('data: {'))
      .map(
        (frame) =>
          JSON.parse(frame.slice(6)) as { choices: Array<{ delta: { content?: string } }> },
      )
      .map((frame) => frame.choices[0]?.delta.content ?? '')
      .join('');
    expect(text).toBe('first second');
    await server.close();
  });

  it('buffers tool-mode text, emits indexed tool calls without marker leakage, and includes usage', async () => {
    const markerYielded = deferred();
    const release = deferred();
    const marker =
      '[TOOL_CALLS: [{"function":{"name":"read_file","arguments":{"path":"one"}}},{"function":{"name":"read_file","arguments":{"path":"two"}}}]]';
    const backend: CursorBackend = {
      ...createMockBackend(),
      async *completeStream() {
        markerYielded.resolve();
        yield { type: 'content' as const, text: marker.slice(0, 24) };
        yield { type: 'content' as const, text: marker.slice(24) };
        await release.promise;
        yield {
          type: 'done' as const,
          usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
          is_error: false,
        };
      },
    };
    const server = await buildServer({ config: baseConfig, backend });
    await server.listen({ host: '127.0.0.1', port: 0 });
    const port = (server.server.address() as AddressInfo).port;
    const clientPromise = streamingRequest(port, {
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: 'read two files' }],
      tools: [
        {
          type: 'function',
          function: { name: 'read_file', parameters: { type: 'object' } },
        },
      ],
      parallel_tool_calls: true,
    });

    await markerYielded.promise;
    const { response } = await clientPromise;
    const firstByte = deferred();
    const chunks: Buffer[] = [];
    const ended = deferred();
    response.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      firstByte.resolve();
    });
    response.once('end', () => ended.resolve());
    response.resume();
    await firstByte.promise;
    expect(Buffer.concat(chunks).toString('utf8')).not.toContain('[TOOL_CALLS:');

    release.resolve();
    await ended.promise;
    const body = Buffer.concat(chunks).toString('utf8');
    expect(body).not.toContain('[TOOL_CALLS:');
    const frames = body
      .split('\n\n')
      .filter((frame) => frame.startsWith('data: {'))
      .map(
        (frame) =>
          JSON.parse(frame.slice(6)) as {
            choices: Array<{
              delta: { tool_calls?: Array<{ index: number }> };
            }>;
            usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
          },
      );
    const toolCalls = frames.find((frame) => frame.choices[0]?.delta.tool_calls)?.choices[0]?.delta
      .tool_calls;
    expect(toolCalls?.map((call) => call.index)).toEqual([0, 1]);
    expect(frames.find((frame) => frame.choices.length === 0)?.usage).toEqual({
      prompt_tokens: 11,
      completion_tokens: 7,
      total_tokens: 18,
    });
    await server.close();
  });

  it('does not replay disallowed raw JSON tool payloads into SSE content', async () => {
    const backend: CursorBackend = {
      ...createMockBackend(),
      async *completeStream() {
        yield {
          type: 'content' as const,
          text: '{"tool_calls":[{"function":{"name":"unknown_tool","arguments":{}}}]}',
        };
        yield {
          type: 'done' as const,
          usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
          is_error: false,
        };
      },
    };
    const server = await buildServer({ config: baseConfig, backend });
    const response = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer ***' },
      payload: {
        stream: true,
        messages: [{ role: 'user', content: 'answer or call allowed_tool' }],
        tools: [{ type: 'function', function: { name: 'allowed_tool', parameters: {} } }],
        tool_choice: 'auto',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('unknown_tool');
    await server.close();
  });

  it('streams raw JSON as ordinary SSE content when tool choice is none', async () => {
    const rawJson =
      '{"tool_calls":[{"function":{"name":"disabled_tool","arguments":{"value":"text"}}}]}';
    const backend: CursorBackend = {
      ...createMockBackend(),
      async *completeStream() {
        yield { type: 'content' as const, text: rawJson };
        yield {
          type: 'done' as const,
          usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
          is_error: false,
        };
      },
    };
    const server = await buildServer({ config: baseConfig, backend });
    const response = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer ***' },
      payload: {
        stream: true,
        messages: [{ role: 'user', content: 'return JSON as text' }],
        tools: [{ type: 'function', function: { name: 'disabled_tool', parameters: {} } }],
        tool_choice: 'none',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('disabled_tool');
    await server.close();
  });

  it('streams ordinary content before completion when tools are declared', async () => {
    const contentYielded = deferred();
    const waitingForRelease = deferred();
    const release = deferred();
    const backend: CursorBackend = {
      ...createMockBackend(),
      async *completeStream() {
        contentYielded.resolve();
        yield { type: 'content' as const, text: 'streamed answer' };
        waitingForRelease.resolve();
        await release.promise;
        yield {
          type: 'done' as const,
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          is_error: false,
        };
      },
    };
    const server = await buildServer({ config: baseConfig, backend });
    await server.listen({ host: '127.0.0.1', port: 0 });
    const port = (server.server.address() as AddressInfo).port;
    const clientPromise = streamingRequest(port, {
      stream: true,
      messages: [{ role: 'user', content: 'answer normally' }],
      tools: [{ type: 'function', function: { name: 'unused', parameters: {} } }],
    });

    await contentYielded.promise;
    const { response } = await clientPromise;
    const chunks: Buffer[] = [];
    const ended = deferred();
    const contentReceived = deferred();
    response.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).toString('utf8').includes('streamed answer')) {
        contentReceived.resolve();
      }
    });
    response.once('end', () => ended.resolve());
    response.resume();
    await waitingForRelease.promise;
    const deadline = AbortSignal.timeout(5_000);
    const streamedBeforeCompletion = await Promise.race([
      contentReceived.promise.then(() => true),
      new Promise<boolean>((resolve) => {
        deadline.addEventListener('abort', () => resolve(false), { once: true });
      }),
    ]);
    release.resolve();
    await ended.promise;
    const body = Buffer.concat(chunks).toString('utf8');
    const text = body
      .split('\n\n')
      .filter((frame) => frame.startsWith('data: {'))
      .map(
        (frame) =>
          JSON.parse(frame.slice(6)) as { choices: Array<{ delta: { content?: string } }> },
      )
      .map((frame) => frame.choices[0]?.delta.content ?? '')
      .join('');
    expect(text).toBe('streamed answer');
    expect(streamedBeforeCompletion).toBe(true);
    await server.close();
  });

  it('returns tool_calls when tools are provided with tool_choice=required', async () => {
    const server = await app({ apiKey: 'test-bridge-key' });
    const res = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer test-bridge-key' },
      payload: {
        model: 'composer-2.5',
        messages: [{ role: 'user', content: 'read the file' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'read_file',
              description: 'Read a file',
              parameters: { type: 'object', properties: { path: { type: 'string' } } },
            },
          },
        ],
        tool_choice: 'required',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.choices[0].finish_reason).toBe('tool_calls');
    expect(body.choices[0].message.content).toBe('');
    expect(body.choices[0].message.tool_calls).toBeDefined();
    expect(body.choices[0].message.tool_calls.length).toBeGreaterThan(0);
    expect(body.choices[0].message.tool_calls[0].function.name).toBe('read_file');
  });

  it('returns tool_calls when tool_choice forces a specific function', async () => {
    const server = await app({ apiKey: 'test-bridge-key' });
    const res = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer test-bridge-key' },
      payload: {
        model: 'composer-2.5',
        messages: [{ role: 'user', content: 'read the file' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'read_file',
              description: 'Read a file',
              parameters: { type: 'object', properties: { path: { type: 'string' } } },
            },
          },
        ],
        tool_choice: { type: 'function', function: { name: 'read_file' } },
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.choices[0].finish_reason).toBe('tool_calls');
    expect(body.choices[0].message.tool_calls[0].function.name).toBe('read_file');
  });

  it('streams tool_calls in SSE when tools are provided with tool_choice=required', async () => {
    const server = await app({ apiKey: 'test-bridge-key' });
    const res = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer test-bridge-key' },
      payload: {
        model: 'composer-2.5',
        stream: true,
        messages: [{ role: 'user', content: 'read the file' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'read_file',
              description: 'Read a file',
              parameters: { type: 'object', properties: { path: { type: 'string' } } },
            },
          },
        ],
        tool_choice: 'required',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-type'])).toContain('text/event-stream');
    const chunks = res.body
      .split('\n\n')
      .filter((line) => line.startsWith('data: {'))
      .map(
        (line) =>
          JSON.parse(line.slice('data: '.length)) as {
            choices: Array<{ delta: { tool_calls?: unknown; content?: string } }>;
          },
      );
    const toolCallChunks = chunks.filter((c) => c.choices[0]?.delta?.tool_calls);
    expect(toolCallChunks.length).toBeGreaterThan(0);
    expect(res.body.trim().endsWith('data: [DONE]')).toBe(true);
  });

  it('returns normal content when tools are not provided', async () => {
    const server = await app();
    const res = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer ***' },
      payload: {
        model: 'composer-2.5',
        messages: [{ role: 'user', content: 'hello no tools' }],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.choices[0].finish_reason).toBe('stop');
    expect(body.choices[0].message.content).toContain('mock cursor response');
    expect(body.choices[0].message.tool_calls).toBeUndefined();
  });

  it('accepts empty or null assistant content from OpenAI tool-call history', async () => {
    const server = await app({ apiKey: 'test-bridge-key' });

    for (const assistantContent of ['', null]) {
      const res = await server.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: 'Bearer test-bridge-key' },
        payload: {
          model: 'composer-2.5',
          messages: [
            { role: 'user', content: 'read /tmp/test.txt' },
            {
              role: 'assistant',
              content: assistantContent,
              tool_calls: [
                {
                  id: 'call_history_1',
                  type: 'function',
                  function: { name: 'read_file', arguments: '{"path":"/tmp/test.txt"}' },
                },
              ],
            },
            { role: 'tool', tool_call_id: 'call_history_1', content: 'EMPTY_CONTENT_OK' },
            { role: 'user', content: 'summarize the tool result' },
          ],
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.choices[0].message.content).toContain('summarize the tool result');
    }
  });

  it('replays emitted tool-call messages with empty content and tool results only', async () => {
    const server = await app({ apiKey: 'test-bridge-key' });
    const first = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer test-bridge-key' },
      payload: {
        model: 'composer-2.5',
        messages: [{ role: 'user', content: 'read /tmp/test.txt' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'read_file',
              parameters: { type: 'object', properties: { path: { type: 'string' } } },
            },
          },
        ],
        tool_choice: 'required',
      },
    });

    expect(first.statusCode).toBe(200);
    const firstMessage = first.json().choices[0].message as {
      role: string;
      content: string | null;
      tool_calls: Array<{ id: string }>;
    };
    expect(firstMessage.content).toBe('');
    expect(firstMessage.tool_calls.length).toBeGreaterThan(0);

    const replay = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer test-bridge-key' },
      payload: {
        model: 'composer-2.5',
        messages: [
          { role: 'user', content: 'read /tmp/test.txt' },
          firstMessage,
          {
            role: 'tool',
            tool_call_id: firstMessage.tool_calls[0]?.id,
            content: 'file contents',
          },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'read_file',
              parameters: { type: 'object' },
            },
          },
        ],
        tool_choice: 'auto',
      },
    });

    expect(replay.statusCode).toBe(200);
    await server.close();
  });

  it('accepts and truncates long tool descriptions from Hermes tool schemas', async () => {
    let observedDescription = '';
    const backend = {
      ...createMockBackend(),
      async complete(request: {
        tools?: Array<{ function: { description?: string } }>;
        model: string;
      }) {
        observedDescription = request.tools?.[0]?.function.description ?? '';
        return {
          content: 'LONG_TOOL_DESC_OK',
          model: request.model,
        };
      },
    };
    const server = await buildServer({
      config: { ...baseConfig, apiKey: 'test-bridge-key' },
      backend,
    });
    const longDescription = 'A'.repeat(2_500);

    const res = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer test-bridge-key' },
      payload: {
        model: 'composer-2.5',
        messages: [{ role: 'user', content: 'use long tool desc' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'long_tool',
              description: longDescription,
              parameters: { type: 'object', properties: {} },
            },
          },
        ],
        tool_choice: 'none',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().choices[0].message.content).toContain('LONG_TOOL_DESC_OK');
    expect(observedDescription.length).toBeLessThanOrEqual(2_000);
    expect(observedDescription).toContain('[description truncated by cursor composer bridge]');
  });

  it('defaults Composer tool rounds to one call when parallel mode is omitted', async () => {
    let observedParallelToolCalls: boolean | undefined;
    const backend: CursorBackend = {
      ...createMockBackend(),
      async complete(request) {
        observedParallelToolCalls = request.parallel_tool_calls;
        return { content: 'COMPOSER_DEFAULT_OK', model: request.model };
      },
    };
    const server = await buildServer({
      config: { ...baseConfig, apiKey: 'test-bridge-key' },
      backend,
    });

    const response = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer test-bridge-key' },
      payload: {
        model: 'composer-2.5',
        messages: [{ role: 'user', content: 'Call the tool.' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'step',
              parameters: { type: 'object', properties: {} },
            },
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(observedParallelToolCalls).toBe(false);
    await server.close();
  });

  it('preserves explicitly enabled Composer parallel tool calls', async () => {
    let observedParallelToolCalls: boolean | undefined;
    const backend: CursorBackend = {
      ...createMockBackend(),
      async complete(request) {
        observedParallelToolCalls = request.parallel_tool_calls;
        return { content: 'COMPOSER_PARALLEL_OK', model: request.model };
      },
    };
    const server = await buildServer({
      config: { ...baseConfig, apiKey: 'test-bridge-key' },
      backend,
    });

    const response = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer test-bridge-key' },
      payload: {
        model: 'composer-2.5',
        messages: [{ role: 'user', content: 'Call both tools.' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'step',
              parameters: { type: 'object', properties: {} },
            },
          },
        ],
        parallel_tool_calls: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(observedParallelToolCalls).toBe(true);
    await server.close();
  });

  it('retries invalid tool arguments once, then returns a detailed 502', async () => {
    const prompts: string[] = [];
    const backend = createCursorCliBackend(
      { ...baseConfig, backend: 'cursor-cli' },
      {
        commandRunner: async (_command, _args, _cwd, _timeoutMs, stdin) => {
          prompts.push(stdin ?? '');
          return '[TOOL_CALLS: [{"function":{"name":"read_file","arguments":{}}}]]';
        },
      },
    );
    const server = await buildServer({
      config: { ...baseConfig, backend: 'cursor-cli' },
      backend,
    });

    const res = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer ***' },
      payload: {
        messages: [{ role: 'user', content: 'read a file' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'read_file',
              parameters: {
                type: 'object',
                properties: { path: { type: 'string' } },
                required: ['path'],
              },
            },
          },
        ],
        tool_choice: 'required',
      },
    });

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('TOOL ARGUMENT VALIDATION FEEDBACK');
    expect(res.statusCode).toBe(502);
    expect(res.json().error.type).toBe('backend_error');
    expect(res.json().error.message).toContain('read_file');
    expect(res.json().error.message).toContain('required property');
  });

  it('surfaces aggregate Cursor is_error messages as backend 502 responses', async () => {
    const backend = createCursorCliBackend(
      { ...baseConfig, backend: 'cursor-cli' },
      {
        commandRunner: async () =>
          JSON.stringify({
            type: 'result',
            subtype: 'error',
            is_error: true,
            result: 'Cursor upstream quota exhausted',
          }),
      },
    );
    const server = await buildServer({
      config: { ...baseConfig, backend: 'cursor-cli' },
      backend,
    });

    const res = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer ***' },
      payload: { messages: [{ role: 'user', content: 'hello' }] },
    });

    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({
      error: { type: 'backend_error', message: 'Cursor upstream quota exhausted' },
    });
  });

  it('serves the dashboard management console shell', async () => {
    const server = await app();
    const res = await server.inject({ method: 'GET', url: '/dashboard' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('id="app"');
  });

  it('sets CSP for http dashboard fetches without upgrade-insecure-requests', async () => {
    const server = await app();
    const res = await server.inject({ method: 'GET', url: '/dashboard' });
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("connect-src 'self' http:");
    expect(csp).not.toContain('upgrade-insecure-requests');
  });

  it('compares API keys safely for equal, unequal, and different-length values', () => {
    expect(timingSafeKeyEqual('same-key', 'same-key')).toBe(true);
    expect(timingSafeKeyEqual('same-key', 'other-key')).toBe(false);
    expect(timingSafeKeyEqual('short', 'a-much-longer-key')).toBe(false);
  });

  it('trims configured API keys and rejects whitespace-only configuration', async () => {
    const trimmed = await app({ apiKey: '  trimmed-key  ' });
    const accepted = await trimmed.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: 'Bearer trimmed-key' },
    });
    expect(accepted.statusCode).toBe(200);

    await expect(app({ apiKey: '   ' })).rejects.toThrow('must not be empty or whitespace');
  });

  it('single-flights backend health across parallel unauthenticated probes', async () => {
    let calls = 0;
    const backend: CursorBackend = {
      ...createMockBackend(),
      async health() {
        calls += 1;
        await Promise.resolve();
        return { ok: true, type: 'counted', authConfigured: true };
      },
    };
    const server = await buildServer({ config: baseConfig, backend });

    const responses = await Promise.all(
      Array.from({ length: 20 }, () => server.inject({ method: 'GET', url: '/health' })),
    );

    expect(responses.every((response) => response.statusCode === 200)).toBe(true);
    expect(calls).toBe(1);
  });

  it.each([
    { label: 'global', maxConcurrency: 1, maxConcurrencyPerKey: 2 },
    { label: 'per-key', maxConcurrency: 2, maxConcurrencyPerKey: 1 },
  ])('returns 429 when the $label in-flight completion cap is full', async (limits) => {
    const started = deferred();
    const release = deferred();
    const backend: CursorBackend = {
      ...createMockBackend(),
      async complete(request) {
        started.resolve();
        await release.promise;
        return { content: 'done', model: request.model };
      },
    };
    const server = await buildServer({
      config: { ...baseConfig, ...limits },
      backend,
    });
    const payload = { messages: [{ role: 'user', content: 'block' }] };

    const first = server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer ***' },
      payload,
    });
    await started.promise;
    const limited = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer ***' },
      payload,
    });

    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('1');
    expect(limited.json().error.type).toBe('rate_limit_error');
    release.resolve();
    expect((await first).statusCode).toBe(200);
  });

  it('admits sixteen same-key completions by default', async () => {
    let started = 0;
    const allStarted = deferred();
    const release = deferred();
    const backend: CursorBackend = {
      ...createMockBackend(),
      async complete(request) {
        started += 1;
        if (started === 16) allStarted.resolve();
        await release.promise;
        return { content: 'done', model: request.model };
      },
    };
    const server = await buildServer({ config: baseConfig, backend });
    const requests = Array.from({ length: 16 }, () =>
      server.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: 'Bearer ***' },
        payload: { messages: [{ role: 'user', content: 'hold capacity' }] },
      }),
    );
    const admissionDeadline = AbortSignal.timeout(1_000);
    const admission = await Promise.race([
      allStarted.promise.then(() => 'all-started'),
      Promise.race(requests).then((response) => `response-${response.statusCode}`),
      new Promise<string>((resolve) => {
        admissionDeadline.addEventListener('abort', () => resolve('timeout'), { once: true });
      }),
    ]);

    let overflowStatus: number | undefined;
    try {
      if (admission === 'all-started') {
        const overflow = await server.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: { authorization: 'Bearer ***' },
          payload: { messages: [{ role: 'user', content: 'overflow capacity' }] },
        });
        overflowStatus = overflow.statusCode;
      }
    } finally {
      release.resolve();
    }
    expect((await Promise.all(requests)).every((response) => response.statusCode === 200)).toBe(
      true,
    );
    expect(admission).toBe('all-started');
    expect(overflowStatus).toBe(429);
    await server.close();
  });

  it('maps output-limit failures to an OpenAI-style 502 backend error', async () => {
    const backend: CursorBackend = {
      ...createMockBackend(),
      async complete() {
        throw new CursorBackendError('output limit exceeded');
      },
    };
    const server = await buildServer({ config: baseConfig, backend });

    const response = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer ***' },
      payload: { messages: [{ role: 'user', content: 'overflow' }] },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({
      error: { type: 'backend_error', message: 'output limit exceeded' },
    });
  });

  it('returns JSON 502 before SSE starts and an SSE error after a midstream failure', async () => {
    const beforeBackend: CursorBackend = {
      ...createMockBackend(),
      async *completeStream() {
        yield* [];
        throw new CursorBackendError('failed before first event');
      },
    };
    const beforeServer = await buildServer({ config: baseConfig, backend: beforeBackend });
    const before = await beforeServer.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer ***' },
      payload: { stream: true, messages: [{ role: 'user', content: 'fail first' }] },
    });
    expect(before.statusCode).toBe(502);
    expect(before.json().error.message).toBe('failed before first event');

    const afterBackend: CursorBackend = {
      ...createMockBackend(),
      async *completeStream() {
        yield { type: 'content' as const, text: 'partial' };
        throw new CursorBackendError('failed after content');
      },
    };
    const afterServer = await buildServer({ config: baseConfig, backend: afterBackend });
    const after = await afterServer.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer ***' },
      payload: { stream: true, messages: [{ role: 'user', content: 'fail later' }] },
    });
    expect(after.statusCode).toBe(200);
    const errorFrame = after.body
      .split('\n\n')
      .find((frame) => frame.startsWith('data: {') && frame.includes('"error"'));
    expect(JSON.parse(errorFrame?.slice(6) ?? '{}')).toEqual({
      error: { message: 'failed after content', type: 'backend_error' },
    });
    expect(after.body).not.toContain('"finish_reason":"stop"');
    expect(after.body).not.toContain('data: [DONE]');
  });

  it('aborts the streaming Cursor child when the HTTP client disconnects', async () => {
    class StreamingChild extends EventEmitter {
      readonly stdin = new PassThrough();
      readonly stdout = new PassThrough();
      readonly stderr = new PassThrough();
      readonly pid = 987_655;
      kill(): boolean {
        return true;
      }
      exit(signal: NodeJS.Signals): void {
        this.emit('exit', null, signal);
        this.emit('close', null, signal);
      }
    }

    const spawned = deferred<StreamingChild>();
    const terminated = deferred();
    const spawn: CursorSpawn = () => {
      const child = new StreamingChild();
      spawned.resolve(child);
      return child as unknown as ChildProcess;
    };
    const backend = createCursorCliBackend(
      { ...baseConfig, backend: 'cursor-cli' },
      {
        spawn,
        environment: { PATH: process.env.PATH, CURSOR_BRIDGE_CURSOR_BIN: 'cursor-agent' },
        signalChild(child, signal) {
          if (signal === 'SIGTERM') {
            terminated.resolve();
            queueMicrotask(() => (child as unknown as StreamingChild).exit(signal));
          }
        },
      },
    );
    const server = await buildServer({
      config: { ...baseConfig, backend: 'cursor-cli' },
      backend,
    });
    await server.listen({ host: '127.0.0.1', port: 0 });
    const port = (server.server.address() as AddressInfo).port;
    const clientPromise = streamingRequest(port, {
      stream: true,
      messages: [{ role: 'user', content: 'disconnect stream' }],
    });
    const child = await spawned.promise;
    child.stdout.write(
      `${JSON.stringify({ type: 'thinking', subtype: 'delta', text: 'working' })}\n`,
    );
    const { request, response } = await clientPromise;
    const firstByte = deferred();
    response.once('data', () => firstByte.resolve());
    response.resume();
    await firstByte.promise;
    response.destroy();
    request.destroy();
    await terminated.promise;
    await server.close();
  });

  it('propagates a listening HTTP client disconnect to backend completion', async () => {
    const started = deferred();
    const aborted = deferred();
    const backend: CursorBackend = {
      ...createMockBackend(),
      async complete(request, signal) {
        started.resolve();
        await new Promise<void>((_resolve, reject) => {
          const onAbort = () => {
            aborted.resolve();
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          };
          signal?.addEventListener('abort', onAbort, { once: true });
        });
        return { content: 'unreachable', model: request.model };
      },
    };
    const server = await buildServer({ config: baseConfig, backend });
    await server.listen({ host: '127.0.0.1', port: 0 });
    const address = server.server.address() as AddressInfo;
    const clientClosed = deferred();
    const client = httpRequest({
      host: '127.0.0.1',
      port: address.port,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        authorization: 'Bearer ***',
        'content-type': 'application/json',
      },
    });
    client.on('error', () => undefined);
    client.on('close', () => clientClosed.resolve());
    client.end(JSON.stringify({ messages: [{ role: 'user', content: 'disconnect' }] }));

    await started.promise;
    client.destroy();
    await Promise.all([aborted.promise, clientClosed.promise]);
    await server.close();
  });
});
