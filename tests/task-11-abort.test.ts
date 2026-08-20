import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { CompletionStreamEvent, CursorBackend } from '../src/backend/types.js';
import type { BridgeConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import type { TraceRecord } from '../src/trace.js';

const config: BridgeConfig = {
  host: '127.0.0.1',
  port: 0,
  clientAuth: 'off',
  backend: 'mock',
  defaultModel: 'composer-2.5',
  workspaceMode: 'chat-only',
  maxConcurrency: 1,
  maxConcurrencyPerKey: 1,
  version: 'test',
};

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  const deadline = AbortSignal.timeout(10_000);
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      deadline.addEventListener(
        'abort',
        () => reject(new Error(`${label} exceeded 10 second acknowledgement bound`)),
        { once: true },
      );
    }),
  ]);
}

describe('task 11 abort quiescence', () => {
  it('releases capacity after repeated abort and suppresses every late client event', async () => {
    const subscribed = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const terminal = Promise.withResolvers<TraceRecord>();
    let calls = 0;
    const backend: CursorBackend = {
      type: 'mock',
      health: async () => ({ ok: true, type: 'mock', authConfigured: true }),
      listModels: async () => [],
      complete: async (request) => ({
        content: 'NEXT_REQUEST_ACQUIRED',
        model: request.model,
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        usage_source: 'unknown',
      }),
      completeStream: async function* (_request, signal): AsyncIterable<CompletionStreamEvent> {
        calls += 1;
        const abortObserved = Promise.withResolvers<void>();
        const onAbort = (): void => {
          aborted.resolve();
          abortObserved.resolve();
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        subscribed.resolve();
        try {
          yield { type: 'content', text: 'VISIBLE_BEFORE_ABORT' };
          await abortObserved.promise;
          yield { type: 'content', text: 'FORBIDDEN_LATE_SENTINEL' };
          yield {
            type: 'done',
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            usage_source: 'unknown',
            is_error: false,
          };
        } finally {
          signal?.removeEventListener('abort', onAbort);
        }
      },
    };
    const records: TraceRecord[] = [];
    const server = await buildServer({
      config,
      backend,
      trace: {
        environment: { CURSOR_BRIDGE_TRACE: '1' },
        sink: (record) => {
          records.push(record);
          if (record.stage === 'terminal') terminal.resolve(record);
        },
      },
    });
    await server.listen({ host: '127.0.0.1', port: 0 });
    const port = (server.server.address() as AddressInfo).port;
    let body = '';
    const clientClosed = Promise.withResolvers<void>();
    const client = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      },
      (response) => {
        response.on('data', (chunk: Buffer) => {
          body += chunk.toString('utf8');
          if (!body.includes('VISIBLE_BEFORE_ABORT')) return;
          client.destroy();
          client.destroy();
        });
      },
    );
    client.once('error', () => undefined);
    client.once('close', () => clientClosed.resolve());
    client.end(
      JSON.stringify({
        model: 'composer-2.5',
        stream: true,
        messages: [{ role: 'user', content: 'abort this request' }],
      }),
    );

    await bounded(subscribed.promise, 'abort subscription');
    await bounded(Promise.all([aborted.promise, clientClosed.promise]), 'cancellation');
    const terminalRecord = await bounded(terminal.promise, 'quiescence');
    const next = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'composer-2.5',
        messages: [{ role: 'user', content: 'acquire released capacity' }],
      },
    });
    await server.close();

    expect(calls).toBe(1);
    expect(body).toContain('VISIBLE_BEFORE_ABORT');
    expect(body).not.toContain('FORBIDDEN_LATE_SENTINEL');
    expect(next.statusCode).toBe(200);
    expect(next.json().choices[0].message.content).toBe('NEXT_REQUEST_ACQUIRED');
    expect(terminalRecord).toMatchObject({
      terminal: 'abort',
      cancelled: true,
      quiescent: true,
    });
    expect(records.filter((record) => record.stage === 'abort')).toHaveLength(1);
    expect(records.filter((record) => record.stage === 'terminal')).toHaveLength(2);
  });
});
