import { EventEmitter } from 'node:events';
import type { OutgoingHttpHeaders } from 'node:http2';
import { describe, expect, it, vi } from 'vitest';
import { CursorAuthProvider } from '../src/backend/cursor-api/auth.js';
import { fingerprintCredential } from '../src/backend/cursor-api/h2-session-pool.js';
import { CursorApiBackend } from '../src/backend/cursor-api/index.js';
import {
  type CursorRunStream,
  NodeCursorApiTransport,
} from '../src/backend/cursor-api/transport.js';
import type { BridgeConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { createRequestTrace, type TraceRecord } from '../src/trace.js';

class ReleasedSessionOwnershipReadError extends Error {
  readonly name = 'ReleasedSessionOwnershipReadError';

  constructor() {
    super('shutdown consulted a remotely closed session after ownership release');
  }
}

const config: BridgeConfig = {
  host: '127.0.0.1',
  port: 0,
  apiKey: 'bridge-key',
  backend: 'cursor-api',
  defaultModel: 'composer-2.5',
  workspaceMode: 'chat-only',
  version: '0.1.0',
};

class FakeStream extends EventEmitter implements CursorRunStream {
  destroyed = false;
  writableEnded = false;
  rstCode = 0;

  write(): boolean {
    return true;
  }

  end(): void {
    if (this.destroyed || this.writableEnded) return;
    this.writableEnded = true;
  }

  destroy(error?: Error): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (error && this.listenerCount('error') > 0) this.emit('error', error);
    this.emit('close');
  }

  close(): void {
    if (this.writableEnded) return;
    this.writableEnded = true;
    this.emit('close');
  }
}

class FakeSession extends EventEmitter {
  closed = false;
  destroyed = false;
  closeCalls = 0;
  readonly headers: OutgoingHttpHeaders[] = [];
  readonly streams: FakeStream[] = [];

  request(headers: OutgoingHttpHeaders): FakeStream {
    if (this.closed || this.destroyed) throw new Error('request on drained session');
    const stream = new FakeStream();
    this.headers.push(headers);
    this.streams.push(stream);
    return stream;
  }

  close(): void {
    this.closeCalls += 1;
    this.closed = true;
    this.emit('close');
  }

  goaway(errorCode = 0, lastStreamId = 0, opaqueData = Buffer.alloc(0)): void {
    this.emit('goaway', errorCode, lastStreamId, opaqueData);
  }

  fail(error: Error): void {
    this.emit('error', error);
  }

  remoteClose(): void {
    this.closed = true;
    this.emit('close');
  }

  remoteCloseAndRejectOwnershipReads(): void {
    this.remoteClose();
    Object.defineProperty(this, 'closed', {
      configurable: true,
      get: () => {
        throw new ReleasedSessionOwnershipReadError();
      },
    });
  }

  repeatRemoteClose(): void {
    this.emit('close');
  }
}

function transportFixture(maxSessionPoolEntries?: number) {
  const sessions: FakeSession[] = [];
  const connect = vi.fn(() => {
    const session = new FakeSession();
    sessions.push(session);
    return session;
  });
  const transport = new NodeCursorApiTransport({
    auth: new CursorAuthProvider({
      environment: { CURSOR_AUTH_TOKEN: 'fallback-token' },
    }),
    clientVersion: 'cli-test',
    connect,
    ...(maxSessionPoolEntries === undefined ? {} : { maxSessionPoolEntries }),
  });
  return { connect, sessions, transport };
}

async function open(
  transport: NodeCursorApiTransport,
  requestId: string,
  token = 'credential-token-a',
): Promise<CursorRunStream> {
  return transport.openRun('https://AGENT.test:443/', requestId, token);
}

describe('Node Cursor API HTTP/2 session reuse', () => {
  it('reuses one healthy session for two sequential streams with per-stream headers', async () => {
    // Given
    const { connect, sessions, transport } = transportFixture();

    // When
    const first = await open(transport, 'request-1');
    first.close();
    const second = await open(transport, 'request-2');

    // Then
    expect(connect).toHaveBeenCalledOnce();
    expect(sessions[0]?.headers).toHaveLength(2);
    expect(sessions[0]?.headers.map((headers) => headers.authorization)).toEqual([
      'Bearer credential-token-a',
      'Bearer credential-token-a',
    ]);
    expect(sessions[0]?.headers.map((headers) => headers['x-request-id'])).toEqual([
      'request-1',
      'request-2',
    ]);
    expect(second.destroyed).toBe(false);
  });

  it('opens concurrent-safe streams on one healthy session', async () => {
    // Given
    const { connect, sessions, transport } = transportFixture();

    // When
    const [first, second] = await Promise.all([
      open(transport, 'concurrent-1'),
      open(transport, 'concurrent-2'),
    ]);

    // Then
    expect(connect).toHaveBeenCalledOnce();
    expect(sessions[0]?.streams).toEqual([first, second]);
  });

  it('keys sessions by canonical endpoint and credential fingerprint', async () => {
    // Given
    const { connect, sessions, transport } = transportFixture();

    // When
    await open(transport, 'canonical-1', 'credential-a');
    await transport.openRun('https://agent.test', 'canonical-2', 'credential-a');
    await open(transport, 'credential-2', 'credential-b');
    await transport.openRun('https://other-agent.test', 'endpoint-2', 'credential-a');

    // Then
    expect(connect).toHaveBeenCalledTimes(3);
    expect(sessions.map((session) => session.headers.length)).toEqual([2, 1, 1]);
    expect(fingerprintCredential('credential-a')).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintCredential('credential-a')).not.toContain('credential-a');
  });

  it('bounds retained healthy sessions', async () => {
    // Given
    const { sessions, transport } = transportFixture(2);

    // When
    for (let index = 0; index < 3; index += 1) {
      await open(transport, `request-${index}`, `credential-token-${index}`);
    }

    // Then
    expect(sessions).toHaveLength(3);
    expect(sessions[0]?.closeCalls).toBe(1);
    expect(sessions.slice(1).every((session) => session.closeCalls === 0)).toBe(true);
  });

  it.each(['goaway', 'error', 'close'] as const)(
    'evicts a session on %s and creates exactly one replacement',
    async (event) => {
      // Given
      const { connect, sessions, transport } = transportFixture();
      await open(transport, 'request-1');
      const surviving = await open(transport, 'request-2');
      surviving.once('error', () => undefined);

      // When
      const session = sessions[0];
      const emitEvent = {
        goaway: () => session?.goaway(),
        error: () =>
          session?.fail(Object.assign(new Error('session failed'), { code: 'ECONNRESET' })),
        close: () => session?.remoteClose(),
      } satisfies Record<typeof event, () => void>;
      emitEvent[event]();
      await open(transport, 'request-3');

      // Then
      expect(connect).toHaveBeenCalledTimes(2);
      expect(sessions[0]?.headers).toHaveLength(2);
      expect(sessions[1]?.headers).toHaveLength(1);
      if (event === 'error') expect(surviving.destroyed).toBe(true);
    },
  );

  it('retains GOAWAY and stream reset metadata for Run timeout diagnostics', async () => {
    // Given: one active Run receives a session-level GOAWAY and has an H2
    // reset code available on its stream.
    const { sessions, transport } = transportFixture();
    const stream = await open(transport, 'diagnostic-run');
    const inner = sessions[0]?.streams[0];
    if (!inner) throw new Error('expected active stream');
    inner.rstCode = 8;

    // When: the upstream session announces GOAWAY without ending the Run.
    sessions[0]?.goaway(11, 37, Buffer.from('meta'));

    // Then: the Run keeps a secret-safe transport snapshot for a later
    // timeout error, even after the pooled session is drained.
    const diagnostics = Reflect.get(stream, 'diagnostics');
    expect(typeof diagnostics).toBe('function');
    expect(typeof diagnostics === 'function' ? diagnostics() : undefined).toEqual({
      rstCode: 8,
      goaway: { errorCode: 11, lastStreamId: 37, opaqueDataLength: 4 },
    });
  });

  it('releases remote-close ownership before transport shutdown', async () => {
    // Given
    const { sessions, transport } = transportFixture();
    await open(transport, 'remote-close-ownership');
    const session = sessions[0];
    expect(session).toBeDefined();

    // When
    session?.remoteCloseAndRejectOwnershipReads();
    session?.repeatRemoteClose();

    // Then
    await expect(transport.shutdown()).resolves.toBeUndefined();
  });

  it('keeps a sibling stream and its session alive when one Run aborts', async () => {
    // Given
    const { sessions, transport } = transportFixture();
    const aborted = await open(transport, 'request-aborted');
    const sibling = await open(transport, 'request-sibling');

    // When
    aborted.destroy(new Error('aborted'));

    // Then
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.closeCalls).toBe(0);
    expect(sibling.destroyed).toBe(false);
  });

  it('emits secret-safe session-connect and stream-open trace stages', async () => {
    // Given
    const { transport } = transportFixture();
    const records: TraceRecord[] = [];
    const trace = createRequestTrace({
      environment: { CURSOR_BRIDGE_TRACE: '1' },
      requestId: 'trace-request',
      model: 'composer-2.5',
      sink: (record) => records.push(record),
      now: () => records.length,
    });

    // When
    await transport.openRun('https://agent.test', 'stream-1', 'trace-token-secret', trace);
    await transport.openRun('https://agent.test', 'stream-2', 'trace-token-secret', trace);

    // Then
    expect(records.map((record) => record.stage)).toEqual([
      'run_open',
      'h2_session_connect',
      'run_stream_open',
      'run_open',
      'run_stream_open',
    ]);
    expect(JSON.stringify(records)).not.toContain('trace-token-secret');
  });

  it('waits for session close on shutdown even when closed is already true', async () => {
    // Given: close() flipped the flag but the 'close' event has not flushed yet.
    const { sessions, transport } = transportFixture();
    await open(transport, 'late-close');
    const session = sessions[0];
    if (!session) throw new Error('expected pooled session');
    session.closed = true;
    const order: string[] = [];
    setTimeout(() => {
      order.push('close');
      session.emit('close');
    }, 40);

    // When
    await transport.shutdown();
    order.push('shutdown');

    // Then: skipping the wait because `closed` is true would finish first.
    expect(order).toEqual(['close', 'shutdown']);
  });

  it('closes every pooled session exactly once through bridge shutdown', async () => {
    // Given
    const { sessions, transport } = transportFixture();
    await open(transport, 'request-a', 'credential-a');
    await open(transport, 'request-b', 'credential-b');
    const backend = new CursorApiBackend(config, {
      transport,
      auth: new CursorAuthProvider({
        environment: { CURSOR_AUTH_TOKEN: 'fallback-token' },
      }),
    });
    const server = await buildServer({ config, backend });

    // When
    await server.close();
    await backend.shutdown();

    // Then
    expect(sessions.map((session) => session.closeCalls)).toEqual([1, 1]);
  });
});
