import http2 from 'node:http2';
import https from 'node:https';
import { request as httpRequest } from 'node:http';
import type { AddressInfo, Server as NetServer } from 'node:net';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeConnectFrame } from '../src/backend/cursor-api/connect-frame.js';
import { loadProtoDescriptors, ProtoCodec } from '../src/backend/cursor-api/protobuf.js';
import { generateCerts } from '../scripts/wire-capture/gen-certs.mjs';
import fs from 'node:fs';

const codec = new ProtoCodec(loadProtoDescriptors());
const DIST_ENTRY = path.join(__dirname, '..', 'dist', 'index.js');

async function bounded<T>(promise: Promise<T>, label: string, ms = 10_000): Promise<T> {
  const deadline = AbortSignal.timeout(ms);
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      deadline.addEventListener(
        'abort',
        () => reject(new Error(`${label} exceeded ${ms}ms bound`)),
        { once: true },
      );
    }),
  ]);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe: NetServer = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

interface UpstreamObservation {
  readonly firstChunkSent: Promise<void>;
  readonly runClosed: Promise<void>;
  readonly sessionClosed: Promise<void>;
  readonly goawayCode: () => number | undefined;
  readonly runRstCode: () => number | undefined;
}

/**
 * Fake Cursor upstream over real TLS-free HTTP/2 + HTTP/1.1: answers the
 * GetServerConfig unary, opens the Run stream with one textDelta, then holds
 * the stream open so the bridge still has an in-flight Run when it is SIGTERMed.
 */
async function startUpstream(): Promise<{
  unaryOrigin: string;
  h2Origin: string;
  caPath: string;
  observation: Promise<UpstreamObservation>;
  close: () => Promise<void>;
}> {
  const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shutdown-certs-'));
  generateCerts({ out: certDir });
  const key = fs.readFileSync(path.join(certDir, 'leaf.key'));
  const cert = fs.readFileSync(path.join(certDir, 'leaf.crt'));
  // HTTPS leg for unary fetch calls (GetServerConfig during boot probe).
  const unary = https.createServer({ key, cert }, (request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/proto' });
      response.end(
        Buffer.from(
          codec.encode('aiserver.v1.GetServerConfigResponse', {
            agentUrlConfig: { agentnUrl: 'https://127.0.0.1' },
          }),
        ),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    unary.once('error', reject);
    unary.listen(0, '127.0.0.1', () => resolve());
  });
  const unaryPort = (unary.address() as AddressInfo).port;

  const observed = Promise.withResolvers<UpstreamObservation>();
  const sessions: http2.Http2Session[] = [];
  const server = http2.createSecureServer({ key, cert });
  server.on('session', (session) => {
    sessions.push(session);
    session.on('error', () => undefined);
  });
  server.on('stream', (stream: http2.ServerHttp2Stream) => {
    const firstChunkSent = Promise.withResolvers<void>();
    const runClosed = Promise.withResolvers<void>();
    const sessionClosed = Promise.withResolvers<void>();
    let goawayCode: number | undefined;
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
              value: { message: { case: 'textDelta', value: { text: 'SHUTDOWN_SENTINEL' } } },
            },
          }),
        ),
      );
      firstChunkSent.resolve();
    });
    stream.on('close', () => runClosed.resolve());
    const streamSession = stream.session;
    if (!streamSession) throw new Error('server stream has no session');
    streamSession.once('goaway', (code: number) => {
      goawayCode = code;
    });
    streamSession.once('close', () => sessionClosed.resolve());
    stream.respond({ ':status': 200, 'content-type': 'application/connect+proto' });
    observed.resolve({
      firstChunkSent: firstChunkSent.promise,
      runClosed: runClosed.promise,
      sessionClosed: sessionClosed.promise,
      goawayCode: () => goawayCode,
      runRstCode: () => stream.rstCode,
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    unaryOrigin: `https://127.0.0.1:${unaryPort}`,
    h2Origin: `https://127.0.0.1:${address.port}`,
    caPath: path.join(certDir, 'ca.crt'),
    observation: observed.promise,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const session of sessions) if (!session.destroyed) session.destroy();
        unary.close();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  const pending = cleanups.splice(0);
  for (const cleanup of pending.reverse()) await cleanup();
}, 20_000);

describe('bridge process shutdown', () => {
  it('SIGTERM with an in-flight Run closes the upstream session gracefully (GOAWAY, no RST INTERNAL_ERROR)', async () => {
    const upstream = await startUpstream();
    cleanups.push(upstream.close);
    const bridgePort = await freePort();

    const childEnv = { ...process.env };
    delete childEnv.CURSOR_API_KEY;
    const child: ChildProcess = spawn(process.execPath, [DIST_ENTRY], {
      // cwd outside the repo: keep dotenv from loading the project .env (real API key).
      cwd: os.tmpdir(),
      env: {
        ...childEnv,
        CURSOR_BRIDGE_HOST: '127.0.0.1',
        CURSOR_BRIDGE_PORT: String(bridgePort),
        CURSOR_BRIDGE_BACKEND: 'cursor-api',
        CURSOR_BRIDGE_AUTH: 'off',
        CURSOR_AUTH_TOKEN: 'token',
        CURSOR_BRIDGE_CURSOR_API_ENDPOINT: upstream.unaryOrigin,
        CURSOR_BRIDGE_CURSOR_AGENT_ENDPOINT: upstream.h2Origin,
        NODE_EXTRA_CA_CERTS: upstream.caPath,
        CURSOR_BRIDGE_AUTO_PROBE_TIMEOUT_MS: '5000',
        NO_COLOR: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let childLog = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      childLog += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      childLog += chunk.toString('utf8');
    });
    const childExited = Promise.withResolvers<void>();
    child.once('close', () => childExited.resolve());
    cleanups.push(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    });
    await bounded(
      (async () => {
        while (!childLog.includes('listening on')) {
          if (child.exitCode !== null) throw new Error(`bridge exited early: ${childLog}`);
          await new Promise((resolve) => setImmediate(resolve));
        }
      })(),
      'bridge boot',
    );

    const sawChunk = Promise.withResolvers<void>();
    const clientClosed = Promise.withResolvers<void>();
    const client = httpRequest(
      {
        host: '127.0.0.1',
        port: bridgePort,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      },
      (response) => {
        response.on('data', (chunk: Buffer) => {
          if (chunk.toString('utf8').includes('SHUTDOWN_SENTINEL')) {
            sawChunk.resolve();
            // Live ordering: the OMO client dies FIRST (disconnect mid-Run).
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
        messages: [{ role: 'user', content: 'hold the run open' }],
      }),
    );

    await bounded(sawChunk.promise, 'first SSE chunk');
    await bounded(clientClosed.promise, 'client disconnect');
    const observed = await bounded(upstream.observation, 'upstream run stream');
    // Runner teardown: bridge is SIGTERMed after the client died mid-Run.
    child.kill('SIGTERM');
    await bounded(childExited.promise, 'bridge exit');
    await bounded(observed.sessionClosed, 'upstream session close');

    // GOAWAY always precedes session close on the same session, and the
    // listener flag is set synchronously at emit time.
    expect(
      observed.goawayCode(),
      `bridge must send GOAWAY on shutdown (child log: ${childLog.slice(-400)})`,
    ).toBe(http2.constants.NGHTTP2_NO_ERROR);
    expect(observed.runRstCode()).not.toBe(http2.constants.NGHTTP2_INTERNAL_ERROR);
  }, 20_000);
});
