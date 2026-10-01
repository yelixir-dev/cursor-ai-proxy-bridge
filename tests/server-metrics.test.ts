import { request as httpRequest } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { CursorBackendError } from '../src/backend/cursor-cli.js';
import { createMockBackend } from '../src/backend/mock.js';
import type { CursorBackend } from '../src/backend/types.js';
import type { BridgeConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';

const config: BridgeConfig = {
  host: '127.0.0.1',
  port: 0,
  apiKey: 'metrics-test-key',
  clientAuth: 'on',
  backend: 'mock',
  defaultModel: 'composer-2.5',
  workspaceMode: 'chat-only',
  realWorkspacePath: undefined,
  version: '0.1.0',
};
const authorization = 'Bearer metrics-test-key';
const payload = {
  model: 'composer-2.5',
  messages: [{ role: 'user', content: 'PRIVATE_METRICS_PROMPT_MARKER' }],
};

interface MetricSeries {
  readonly model: string;
  readonly route: string;
  readonly stream: boolean;
  readonly requests: number;
  readonly in_flight: number;
  readonly success: number;
  readonly backend_error: number;
  readonly aborted: number;
  readonly rate_limited: number;
  readonly latency_ms: {
    readonly count: number;
    readonly total: number;
    readonly maximum: number;
    readonly average: number;
  };
}

async function metrics(server: FastifyInstance) {
  return server.inject({
    method: 'GET',
    url: '/admin/metrics',
    headers: { authorization },
  });
}

describe('completion metrics', () => {
  it('records capacity rejection while another admitted request is still running', async () => {
    // Given one occupied completion slot with an event-controlled backend.
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const delegate = createMockBackend();
    const backend: CursorBackend = {
      ...delegate,
      async complete(request) {
        started.resolve();
        await release.promise;
        return delegate.complete(request);
      },
    };
    const server = await buildServer({
      config: { ...config, maxConcurrency: 1 },
      backend,
    });
    const request = {
      method: 'POST' as const,
      url: '/v1/chat/completions',
      headers: { authorization },
      payload,
    };
    const first = server.inject(request).then((response) => response);
    try {
      await started.promise;
      // When a second request arrives before the slot is released.
      const rejected = await server.inject(request);
      const observed = await metrics(server);
      // Then rejection and in-flight work are distinct outcomes.
      expect(rejected.statusCode).toBe(429);
      expect(observed.json<{ series: MetricSeries[] }>().series).toEqual([
        expect.objectContaining({
          requests: 2,
          in_flight: 1,
          rate_limited: 1,
          success: 0,
          backend_error: 0,
        }),
      ]);
    } finally {
      release.resolve();
      await first;
      await server.close();
    }
  });

  it('counts a real HTTP disconnect as cancellation after backend cleanup', async () => {
    // Given lifecycle subscriptions established before the HTTP request.
    const started = Promise.withResolvers<void>();
    const settled = Promise.withResolvers<void>();
    const backend: CursorBackend = {
      ...createMockBackend(),
      async complete(request, signal) {
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Client disconnected', 'AbortError')),
            { once: true },
          );
          started.resolve();
        });
        return { content: '', model: request.model };
      },
    };
    const server = await buildServer({
      config,
      backend,
      trace: {
        environment: { CURSOR_BRIDGE_TRACE: '1' },
        sink: (record) => {
          if (record.stage === 'terminal' && record.terminal === 'abort') settled.resolve();
        },
      },
    });
    await server.listen({ host: '127.0.0.1', port: 0 });
    const address = server.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected a TCP test server');
    }
    const clientClosed = Promise.withResolvers<void>();
    const clientErrors: Error[] = [];
    const client = httpRequest({
      host: '127.0.0.1',
      port: address.port,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(3000),
    });
    client.once('error', (error) => clientErrors.push(error));
    client.once('close', () => clientClosed.resolve());
    try {
      // When the client disconnects from an admitted, unfinished completion.
      client.end(JSON.stringify(payload));
      await started.promise;
      client.destroy();
      await Promise.all([settled.promise, clientClosed.promise]);
      const observed = await metrics(server);
      // Then neither a backend error nor a successful request is recorded.
      expect(clientErrors).toMatchObject([{ code: 'ECONNRESET' }]);
      expect(observed.json<{ series: MetricSeries[] }>().series).toEqual([
        expect.objectContaining({
          requests: 1,
          in_flight: 0,
          aborted: 1,
          success: 0,
          backend_error: 0,
        }),
      ]);
    } finally {
      client.destroy();
      await server.close();
    }
  });

  it('protects the read-only metrics endpoint with the existing client authentication', async () => {
    // Given an authenticated server.
    const server = await buildServer({
      config,
      backend: createMockBackend(),
    });
    try {
      // When a caller omits its key.
      const response = await server.inject({
        method: 'GET',
        url: '/admin/metrics',
      });
      // Then metrics use the same authentication boundary as the other admin routes.
      expect(response.statusCode).toBe(401);
    } finally {
      await server.close();
    }
  });

  it.each([
    { model: 'composer-2.5', route: 'direct', expectedRoute: 'direct' },
    { model: 'auto', route: 'litellm', expectedRoute: 'litellm' },
    {
      model: 'composer-2.5',
      route: 'PRIVATE_HEADER_MARKER',
      expectedRoute: 'unknown',
    },
  ])(
    'counts $model on the $expectedRoute route without storing request content',
    async (fixture) => {
      // Given the real HTTP handler and an existing deterministic backend.
      const server = await buildServer({
        config,
        backend: createMockBackend(),
      });
      try {
        // When one admitted completion finishes.
        const response = await server.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: {
            authorization,
            'x-cursor-bridge-route': fixture.route,
          },
          payload: { ...payload, model: fixture.model },
        });
        const observed = await metrics(server);
        // Then the terminal outcome is counted under bounded, explicit labels.
        expect(response.statusCode).toBe(200);
        expect(observed.statusCode).toBe(200);
        const body = observed.json<{ series: MetricSeries[] }>();
        expect(body.series).toHaveLength(1);
        expect(body.series[0]).toMatchObject({
          model: fixture.model,
          route: fixture.expectedRoute,
          stream: false,
          requests: 1,
          in_flight: 0,
          success: 1,
          backend_error: 0,
          aborted: 0,
          rate_limited: 0,
          latency_ms: { count: 1 },
        });
        expect(observed.body).not.toContain('PRIVATE_METRICS_PROMPT_MARKER');
        expect(observed.body).not.toContain('PRIVATE_HEADER_MARKER');
        expect(observed.body).not.toContain('metrics-test-key');
      } finally {
        await server.close();
      }
    },
  );

  it('records backend failures rather than successful HTTP completion', async () => {
    // Given a backend whose completion fails.
    const backend: CursorBackend = {
      ...createMockBackend(),
      async complete() {
        throw new CursorBackendError('PRIVATE_BACKEND_ERROR_MARKER');
      },
    };
    const server = await buildServer({ config, backend });
    try {
      // When the real handler maps the failure to HTTP 502.
      const response = await server.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization },
        payload,
      });
      const observed = await metrics(server);
      // Then the failure is aggregated without retaining the backend error text.
      expect(response.statusCode).toBe(502);
      expect(observed.json<{ series: MetricSeries[] }>().series).toEqual([
        expect.objectContaining({
          route: 'unknown',
          success: 0,
          backend_error: 1,
          in_flight: 0,
        }),
      ]);
      expect(observed.body).not.toContain('PRIVATE_BACKEND_ERROR_MARKER');
    } finally {
      await server.close();
    }
  });

  it('counts an SSE error after HTTP 200 as a failure', async () => {
    // Given a backend that emits content before a stream error.
    const backend: CursorBackend = {
      ...createMockBackend(),
      async *completeStream() {
        yield { type: 'content', text: 'partial' };
        throw new CursorBackendError('stream failed after content');
      },
    };
    const server = await buildServer({ config, backend });
    try {
      // When the streaming response has already sent its successful HTTP headers.
      const response = await server.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization, 'x-cursor-bridge-route': 'litellm' },
        payload: { ...payload, stream: true },
      });
      const observed = await metrics(server);
      // Then terminal semantics, not the HTTP status, determine success.
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('"type":"backend_error"');
      expect(observed.json<{ series: MetricSeries[] }>().series).toEqual([
        expect.objectContaining({
          model: 'composer-2.5',
          route: 'litellm',
          stream: true,
          success: 0,
          backend_error: 1,
          in_flight: 0,
        }),
      ]);
    } finally {
      await server.close();
    }
  });
});
