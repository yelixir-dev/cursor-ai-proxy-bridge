import http2, { type ClientHttp2Stream, type OutgoingHttpHeaders } from 'node:http2';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { CursorAuthProvider } from '../src/backend/cursor-api/auth.js';
import type { CursorApiDiscovery } from '../src/backend/cursor-api/discovery.js';
import {
  fingerprintCredential,
  H2SessionPool,
  type H2ClientSession,
} from '../src/backend/cursor-api/h2-session-pool.js';
import { buildCursorHistory } from '../src/backend/cursor-api/history.js';
import { executeCursorRun } from '../src/backend/cursor-api/run-execution.js';
import { createCursorApiRuntime } from '../src/backend/cursor-api/runtime.js';
import { NodeCursorApiTransport } from '../src/backend/cursor-api/transport.js';
import type { BridgeConfig } from '../src/config.js';

const config: BridgeConfig = {
  host: '127.0.0.1',
  port: 0,
  backend: 'cursor-api',
  defaultModel: 'composer-2.5',
  workspaceMode: 'chat-only',
  version: 'test',
};

interface StreamObservation {
  endStream: boolean;
  aborted: boolean;
  rstCode: number | undefined;
  readonly ended: Promise<void>;
  readonly closed: Promise<void>;
}

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

function observeStream(stream: http2.ServerHttp2Stream): StreamObservation {
  const ended = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const observation: StreamObservation = {
    endStream: false,
    aborted: false,
    rstCode: undefined,
    ended: ended.promise,
    closed: closed.promise,
  };
  stream.on('error', () => undefined);
  stream.on('data', () => undefined);
  stream.on('end', () => {
    observation.endStream = true;
    observation.rstCode = stream.rstCode;
    ended.resolve();
  });
  stream.on('aborted', () => {
    observation.aborted = true;
  });
  stream.on('close', () => {
    observation.rstCode = stream.rstCode;
    closed.resolve();
  });
  return observation;
}

interface LoopbackServer {
  readonly origin: string;
  readonly firstData: Promise<void>;
  readonly observation: Promise<StreamObservation>;
  readonly close: () => Promise<void>;
}

function startLoopback(): Promise<LoopbackServer> {
  const firstData = Promise.withResolvers<void>();
  const observation = Promise.withResolvers<StreamObservation>();
  const sessions: http2.Http2Session[] = [];
  const server = http2.createServer();
  server.on('session', (session) => {
    sessions.push(session);
    session.on('error', () => undefined);
  });
  server.on('stream', (stream: http2.ServerHttp2Stream) => {
    stream.respond({ ':status': 200, 'content-type': 'application/connect+proto' });
    stream.once('data', () => firstData.resolve());
    observation.resolve(observeStream(stream));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo | null;
      if (address === null) {
        reject(new Error('loopback HTTP/2 server has no bound address'));
        return;
      }
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        firstData: firstData.promise,
        observation: observation.promise,
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            for (const session of sessions) {
              if (!session.destroyed) session.destroy();
            }
            server.close((error) => (error ? closeReject(error) : closeResolve()));
          }),
      });
    });
  });
}

function capturingConnector(captured: ClientHttp2Stream[]) {
  return (endpoint: string): H2ClientSession => {
    const session = http2.connect(endpoint);
    session.on('error', () => undefined);
    return {
      get closed() {
        return session.closed;
      },
      get destroyed() {
        return session.destroyed;
      },
      request(headers: OutgoingHttpHeaders) {
        const stream = session.request(headers);
        stream.on('error', () => undefined);
        captured.push(stream);
        return stream;
      },
      close() {
        session.close();
      },
      on(event: 'error', listener: (error: Error) => void) {
        session.on(event, listener);
        return this;
      },
      once(event: 'close' | 'goaway', listener: () => void) {
        session.once(event, listener);
        return this;
      },
    };
  };
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  const pending = cleanups.splice(0);
  for (const cleanup of pending.reverse()) await cleanup();
}, 15_000);

describe('Run stream HTTP/2 half-close', () => {
  it('aborts with END_STREAM/NO_ERROR and never RST INTERNAL_ERROR', async () => {
    const server = await startLoopback();
    cleanups.push(server.close);
    const captured: ClientHttp2Stream[] = [];
    const transport = new NodeCursorApiTransport({
      auth: new CursorAuthProvider({ environment: { CURSOR_AUTH_TOKEN: 'token' } }),
      clientVersion: 'cli-test',
      agentEndpoint: server.origin,
      connect: capturingConnector(captured),
    });
    cleanups.push(async () => transport.shutdown());
    const runtime = createCursorApiRuntime(config, {
      transport,
      environment: { CURSOR_BRIDGE_CURSOR_TIMEOUT_MS: '10000' },
    });
    const request = {
      model: 'composer-2.5',
      messages: [{ role: 'user' as const, content: 'abort mid-stream' }],
    };
    const controller = new AbortController();
    const run = executeCursorRun({
      runtime,
      discovery: {
        requestedModels: new Map<string, never>(),
        agentUrl: async () => server.origin,
      } as unknown as CursorApiDiscovery,
      request,
      accessToken: 'token',
      credentialId: 'test-credential',
      history: buildCursorHistory(request, runtime.codec),
      signal: controller.signal,
    });

    await bounded(server.firstData, 'server first DATA');
    const observed = await bounded(server.observation, 'server stream open');
    controller.abort();
    await expect(bounded(run, 'abort settlement')).rejects.toMatchObject({ name: 'AbortError' });
    await bounded(observed.ended, 'server END_STREAM');

    const clientStream = captured[0];
    expect(clientStream).toBeDefined();
    expect(observed.endStream).toBe(true);
    expect(observed.rstCode).not.toBe(http2.constants.NGHTTP2_INTERNAL_ERROR);
    expect(
      observed.rstCode === undefined || observed.rstCode === http2.constants.NGHTTP2_NO_ERROR,
    ).toBe(true);
    expect(clientStream?.writableEnded).toBe(true);
    expect(clientStream?.destroyed).toBe(false);
  }, 15_000);

  it('RSTs unavoidable transport errors with CANCEL rather than INTERNAL_ERROR', async () => {
    const server = await startLoopback();
    cleanups.push(server.close);
    const pool = new H2SessionPool((endpoint) => {
      const session = http2.connect(endpoint);
      session.on('error', () => undefined);
      return session;
    });
    cleanups.push(async () => {
      pool.shutdown();
    });
    const stream = pool.openStream({
      endpoint: server.origin,
      credentialFingerprint: fingerprintCredential('token'),
      headers: {
        ':method': 'POST',
        ':path': '/agent.v1.AgentService/Run',
      },
    });
    stream.on('error', () => undefined);
    stream.write(Buffer.from('ping'));
    await bounded(server.firstData, 'server first DATA');
    const observed = await bounded(server.observation, 'server stream open');
    stream.destroy(new Error('forced transport error'));
    await bounded(observed.closed, 'server RST close');

    expect(observed.rstCode).toBe(http2.constants.NGHTTP2_CANCEL);
    expect(observed.rstCode).not.toBe(http2.constants.NGHTTP2_INTERNAL_ERROR);
  }, 15_000);
});
