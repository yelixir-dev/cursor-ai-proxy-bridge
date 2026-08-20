import { EventEmitter } from 'node:events';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { AutoCursorBackend } from '../src/backend/auto.js';
import { CursorAuthProvider } from '../src/backend/cursor-api/auth.js';
import { encodeConnectFrame } from '../src/backend/cursor-api/connect-frame.js';
import { CursorApiBackend } from '../src/backend/cursor-api/index.js';
import {
  CursorApiHttpError,
  type CursorApiTransport,
  type CursorRunStream,
} from '../src/backend/cursor-api/transport.js';
import { createMockBackend } from '../src/backend/mock.js';
import type {
  BackendHealth,
  ChatCompletionRequest,
  CompletionResult,
  CompletionStreamEvent,
  CursorBackend,
} from '../src/backend/types.js';
import { buildServer } from '../src/server.js';
import {
  assertSafeTraceFields,
  attachRequestTrace,
  createRequestTrace,
  traceRunOpen,
  type RequestTrace,
  type TraceRecord,
} from '../src/trace.js';
import type { BridgeConfig } from '../src/config.js';

const config: BridgeConfig = {
  host: '127.0.0.1',
  port: 9997,
  clientAuth: 'off',
  backend: 'mock',
  defaultModel: 'composer-2.5',
  workspaceMode: 'chat-only',
  version: 'test',
};

const request: ChatCompletionRequest = {
  model: 'composer-2.5',
  messages: [{ role: 'user', content: 'prompt-secret-do-not-trace' }],
};

function stableStreamBody(body: string): string {
  return body
    .replace(/chatcmpl-[0-9a-f-]+/g, 'chatcmpl-ID')
    .replace(/"created":\d+/g, '"created":CREATED');
}

function stableLogs(chunks: string[]): string[] {
  return chunks.map((chunk) =>
    chunk.replace(/"time":\d+/g, '"time":TIME').replace(/"pid":\d+/g, '"pid":PID'),
  );
}

async function disabledRun(traceValue: string | undefined) {
  const previous = process.env.CURSOR_BRIDGE_TRACE;
  if (traceValue === undefined) delete process.env.CURSOR_BRIDGE_TRACE;
  else process.env.CURSOR_BRIDGE_TRACE = traceValue;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  try {
    const server = await buildServer({ config, backend: createMockBackend() });
    const response = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'composer-2.5',
        stream: true,
        messages: [{ role: 'user', content: 'characterize disabled tracing' }],
      },
    });
    await server.close();
    return {
      statusCode: response.statusCode,
      body: stableStreamBody(response.body),
      stdout: stableLogs(stdout),
      stderr: stableLogs(stderr),
    };
  } finally {
    stdoutWrite.mockRestore();
    stderrWrite.mockRestore();
    if (previous === undefined) delete process.env.CURSOR_BRIDGE_TRACE;
    else process.env.CURSOR_BRIDGE_TRACE = previous;
  }
}

class TraceRunStream extends EventEmitter implements CursorRunStream {
  destroyed = false;
  writableEnded = false;
  private wrote = false;

  constructor(private readonly respond: (stream: TraceRunStream) => void) {
    super();
  }

  write(_chunk: Uint8Array): boolean {
    if (!this.wrote) {
      this.wrote = true;
      queueMicrotask(() => this.respond(this));
    }
    return true;
  }

  end(): void {
    if (this.destroyed || this.writableEnded) return;
    this.writableEnded = true;
  }

  destroy(_error?: Error): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('close');
  }

  close(): void {
    if (this.writableEnded) return;
    this.writableEnded = true;
    this.emit('close');
  }
}

class RetryingTraceTransport implements CursorApiTransport {
  runCount = 0;

  async unary(): Promise<Buffer> {
    return Buffer.alloc(0);
  }

  async openRun(
    _baseUrl: string,
    _requestId: string,
    accessToken?: string,
    trace?: RequestTrace,
  ): Promise<CursorRunStream> {
    expect(accessToken).toBe('cursor-api-key-secret');
    this.runCount += 1;
    traceRunOpen(trace, 'cursor-api');
    if (this.runCount === 1) {
      return new TraceRunStream((stream) => {
        stream.emit('error', Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }));
      });
    }
    return new TraceRunStream((stream) => {
      stream.emit('data', encodeConnectFrame(Buffer.from('{}'), { trailer: true }));
    });
  }
}

function staticBackend(type: string, complete: () => Promise<CompletionResult>): CursorBackend {
  return {
    type,
    health: async (): Promise<BackendHealth> => ({
      ok: true,
      type,
      authConfigured: true,
    }),
    listModels: async () => [],
    complete,
    completeStream: async function* (): AsyncIterable<CompletionStreamEvent> {
      yield {
        type: 'done',
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        is_error: false,
      };
    },
  };
}

function testTrace(records: TraceRecord[]): RequestTrace {
  let now = 10;
  const trace = createRequestTrace({
    environment: { CURSOR_BRIDGE_TRACE: '1' },
    requestId: 'chatcmpl-trace-test',
    model: 'composer-2.5',
    sink: (record) => records.push(record),
    now: () => now++,
  });
  if (!trace) throw new Error('expected tracing to be enabled');
  return trace;
}

describe('bridge request tracing', () => {
  it('characterizes disabled tracing as response- and log-neutral', async () => {
    const absent = await disabledRun(undefined);
    const explicitlyDisabled = await disabledRun('0');

    expect(absent).toEqual(explicitlyDisabled);
    expect(absent.statusCode).toBe(200);
    expect(absent.body).toContain('"content":"mock "');
    expect(absent.body).toContain('"content":"tracing"');
    expect(absent.body).toContain('data: [DONE]');
  });

  it('propagates an ordered accepted-to-terminal trace and counts every upstream Run', async () => {
    const records: TraceRecord[] = [];
    const transport = new RetryingTraceTransport();
    const auth = new CursorAuthProvider({ environment: {} });
    vi.spyOn(auth, 'getToken').mockResolvedValue('cursor-api-key-secret');
    const backend = new CursorApiBackend(
      {
        ...config,
        backend: 'cursor-api',
        cursorApiCredentials: [
          {
            id: 'credential-label',
            apiKey: 'cursor-api-key-secret',
            weight: 1,
            enabled: true,
          },
        ],
      },
      {
        auth,
        transport,
        environment: {
          CURSOR_BRIDGE_CURSOR_AGENT_ENDPOINT: 'https://agent.test',
          CURSOR_BRIDGE_CURSOR_RETRY_BASE_MS: '1',
        },
        wait: async () => undefined,
      },
    );
    let now = 100;
    const server = await buildServer({
      config: { ...config, backend: 'cursor-api' },
      backend,
      trace: {
        environment: { CURSOR_BRIDGE_TRACE: '1' },
        sink: (record) => records.push(record),
        now: () => now++,
      },
    });

    const response = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: request,
    });
    await server.close();

    expect(response.statusCode).toBe(200);
    expect(transport.runCount).toBe(2);
    expect(records.map((record) => record.stage)).toEqual([
      'accepted',
      'queue_acquired',
      'backend',
      'run_open',
      'retry',
      'run_open',
      'first_event',
      'terminal',
    ]);
    expect(
      records
        .filter((record) => record.stage === 'run_open')
        .map((record) => record.upstream_run_count),
    ).toEqual([1, 2]);
    expect(records.find((record) => record.stage === 'retry')?.retry_kind).toBe('transport');
    expect(records.at(-1)?.terminal).toBe('success');
    expect(records.every((record) => record.offset_ms >= 0)).toBe(true);
    expect(records.every((record) => record.request_id === records[0]?.request_id)).toBe(true);
    expect(
      records.every(
        (record) =>
          record.credential_slot_id === null ||
          /^slot_[0-9a-f]{16}$/.test(record.credential_slot_id),
      ),
    ).toBe(true);
    expect(JSON.stringify(records)).not.toMatch(
      /prompt-secret|cursor-api-key-secret|credential-label/i,
    );
  });

  it('records backend selection and a fatal auto-backend flip without error text', async () => {
    const records: TraceRecord[] = [];
    const tracedRequest = structuredClone(request);
    attachRequestTrace(tracedRequest, testTrace(records));
    const failure = new CursorApiHttpError(401, 'authorization-secret');
    const automatic = new AutoCursorBackend(
      staticBackend('cursor-api', async () => Promise.reject(failure)) as CursorBackend & {
        initialize(timeoutMs?: number): Promise<void>;
        probe(timeoutMs?: number): Promise<void>;
      },
      staticBackend('cursor-cli', async () => ({
        content: 'cli',
        model: request.model,
      })),
      {
        now: () => 1,
        warn: vi.fn(),
        cooldownMs: 100,
        fatalThreshold: 3,
        probeTimeoutMs: 10,
        initial: 'cursor-api',
      },
    );

    await expect(automatic.complete(tracedRequest)).rejects.toBe(failure);

    expect(records.map((record) => record.stage)).toEqual(['backend', 'backend_flip']);
    expect(records[1]?.backend).toBe('cursor-cli');
    expect(JSON.stringify(records)).not.toContain('authorization-secret');
  });

  it('rejects secret-bearing fields at the trace schema boundary', () => {
    expect(() => assertSafeTraceFields({ prompt: 'do not log me' })).toThrow(
      /unsafe trace field: prompt/,
    );
    expect(() => assertSafeTraceFields({ api_key: 'do not log me' })).toThrow(
      /unsafe trace field: api_key/,
    );
    expect(() => assertSafeTraceFields({ retryKind: 'transport' })).not.toThrow();
  });

  it('emits one abort terminal when a client disconnect is signaled repeatedly', async () => {
    const records: TraceRecord[] = [];
    const started = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const backend: CursorBackend = {
      ...createMockBackend(),
      async complete(completionRequest, signal) {
        started.resolve();
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => {
              aborted.resolve();
              const error = new Error('aborted');
              error.name = 'AbortError';
              reject(error);
            },
            { once: true },
          );
        });
        return { content: 'unreachable', model: completionRequest.model };
      },
    };
    let now = 50;
    const server = await buildServer({
      config,
      backend,
      trace: {
        environment: { CURSOR_BRIDGE_TRACE: '1' },
        sink: (record) => records.push(record),
        now: () => now++,
      },
    });
    await server.listen({ host: '127.0.0.1', port: 0 });
    const port = (server.server.address() as AddressInfo).port;
    const clientClosed = Promise.withResolvers<void>();
    const client = httpRequest({
      host: '127.0.0.1',
      port,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    client.on('error', () => undefined);
    client.on('close', () => clientClosed.resolve());
    client.end(JSON.stringify(request));

    await started.promise;
    client.destroy();
    client.destroy();
    await Promise.all([aborted.promise, clientClosed.promise]);
    await server.close();

    expect(records.map((record) => record.stage)).toEqual([
      'accepted',
      'queue_acquired',
      'backend',
      'abort',
      'terminal',
    ]);
    expect(records.filter((record) => record.stage === 'abort')).toHaveLength(1);
    expect(records.filter((record) => record.stage === 'terminal')).toHaveLength(1);
    expect(records.at(-1)?.terminal).toBe('abort');
  });
});
