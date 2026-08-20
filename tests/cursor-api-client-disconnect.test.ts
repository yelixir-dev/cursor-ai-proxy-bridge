import http2 from 'node:http2';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { CursorAuthProvider } from '../src/backend/cursor-api/auth.js';
import { CursorApiCompletion } from '../src/backend/cursor-api/completion.js';
import { encodeConnectFrame } from '../src/backend/cursor-api/connect-frame.js';
import { CursorCredentialRouter } from '../src/backend/cursor-api/credentials.js';
import type { CursorApiDiscovery } from '../src/backend/cursor-api/discovery.js';
import { createCursorApiRuntime } from '../src/backend/cursor-api/runtime.js';
import { NodeCursorApiTransport } from '../src/backend/cursor-api/transport.js';
import { loadProtoDescriptors, ProtoCodec } from '../src/backend/cursor-api/protobuf.js';
import type { CursorBackend } from '../src/backend/types.js';
import type { BridgeConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';

const config: BridgeConfig = {
  host: '127.0.0.1',
  port: 0,
  clientAuth: 'off',
  backend: 'cursor-api',
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
        () => reject(new Error(`${label} exceeded 10 second bound`)),
        { once: true },
      );
    }),
  ]);
}

interface UpstreamObservation {
  readonly firstEnd: Promise<void>;
  readonly closed: Promise<void>;
  readonly rstCode: () => number | undefined;
}

/**
 * Fake Cursor agent upstream over real HTTP/2: answers the Run stream with one
 * textDelta frame, then stays open until the client half-closes, at which point
 * it sends a trailer and ends (mirroring the native server accepting a cancel).
 */
const codec = new ProtoCodec(loadProtoDescriptors());

async function startUpstream(): Promise<{
  origin: string;
  observation: Promise<UpstreamObservation>;
  close: () => Promise<void>;
}> {
  const observed = Promise.withResolvers<UpstreamObservation>();
  const sessions: http2.Http2Session[] = [];
  const server = http2.createServer();
  server.on('session', (session) => {
    sessions.push(session);
    session.on('error', () => undefined);
  });
  server.on('stream', (stream: http2.ServerHttp2Stream) => {
    const firstEnd = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    stream.on('error', () => undefined);
    let announced = false;
    stream.on('data', () => {
      if (announced) return;
      announced = true;
      stream.write(
        encodeConnectFrame(
          codec.encode('agent.v1.AgentServerMessage', {
            message: {
              case: 'interactionUpdate',
              value: { message: { case: 'textDelta', value: { text: 'DISCONNECT_SENTINEL' } } },
            },
          }),
        ),
      );
    });
    stream.on('end', () => {
      // Client half-closed gracefully (END_STREAM): close our side with a trailer.
      firstEnd.resolve();
      if (!stream.destroyed && !stream.writableEnded) {
        stream.write(encodeConnectFrame(Buffer.from('{}'), { trailer: true }));
        stream.end();
      }
    });
    stream.on('close', () => closed.resolve());
    stream.respond({ ':status': 200, 'content-type': 'application/connect+proto' });
    observed.resolve({
      firstEnd: firstEnd.promise,
      closed: closed.promise,
      rstCode: () => stream.rstCode,
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    observation: observed.promise,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const session of sessions) if (!session.destroyed) session.destroy();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  const pending = cleanups.splice(0);
  for (const cleanup of pending.reverse()) await cleanup();
}, 15_000);

describe('client disconnect mid-Run', () => {
  it('closes the upstream Run stream without RST INTERNAL_ERROR', async () => {
    const upstream = await startUpstream();
    cleanups.push(upstream.close);

    const auth = new CursorAuthProvider({ environment: { CURSOR_AUTH_TOKEN: 'token' } });
    const transport = new NodeCursorApiTransport({
      auth,
      clientVersion: 'cli-test',
      agentEndpoint: upstream.origin,
    });
    cleanups.push(() => transport.shutdown());
    const runtime = createCursorApiRuntime(config, {
      auth,
      transport,
      environment: {
        CURSOR_BRIDGE_CURSOR_TIMEOUT_MS: '10000',
        CURSOR_AUTH_TOKEN: 'token',
      },
      credentialRouter: new CursorCredentialRouter({ credentials: [{ id: 'system' }] }),
    });
    const discovery = {
      requestedModels: new Map<string, never>(),
      agentUrl: async () => upstream.origin,
    } as unknown as CursorApiDiscovery;
    const completion = new CursorApiCompletion(runtime, discovery);
    const backend: CursorBackend = {
      type: 'cursor-api',
      health: async () => ({ ok: true, type: 'cursor-api', authConfigured: true }),
      listModels: async () => [],
      complete: (request, signal) =>
        completion.complete(request, signal).then((outcome) => outcome),
      completeStream: (request, signal) => completion.completeStream(request, signal),
    };
    const server = await buildServer({ config, backend });
    cleanups.push(async () => {
      await server.close();
    });
    await server.listen({ host: '127.0.0.1', port: 0 });
    const port = (server.server.address() as AddressInfo).port;

    const sawFirstChunk = Promise.withResolvers<void>();
    const clientClosed = Promise.withResolvers<void>();
    let body = '';
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
          if (body.includes('DISCONNECT_SENTINEL')) {
            sawFirstChunk.resolve();
            // Genuine client disconnect mid-Run: destroy the socket, no AbortSignal.
            client.destroy();
          }
        });
      },
    );
    client.once('error', () => undefined);
    client.once('close', () => clientClosed.resolve());
    client.end(
      JSON.stringify({
        model: 'composer-2.5',
        stream: true,
        messages: [{ role: 'user', content: 'disconnect mid-run' }],
      }),
    );

    await bounded(sawFirstChunk.promise, 'first SSE chunk');
    await bounded(clientClosed.promise, 'client socket close');
    const observed = await bounded(upstream.observation, 'upstream stream open');
    await bounded(observed.closed, 'upstream stream close');

    expect(body).toContain('DISCONNECT_SENTINEL');
    expect(observed.rstCode()).not.toBe(http2.constants.NGHTTP2_INTERNAL_ERROR);
  }, 15_000);
});
