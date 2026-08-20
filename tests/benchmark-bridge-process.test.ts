import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  allocateEphemeralPort,
  type BridgeSpawn,
  startBridge,
} from '../src/benchmark/bridge-process.js';

class FakeBridgeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 77_777;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killCalls: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killCalls.push(signal);
    this.exit(0, signal);
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal ?? 'SIGTERM';
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }
}

class FakeIpcBridgeChild extends FakeBridgeChild {
  readonly connected = true;
  readonly sent: unknown[] = [];

  send(message: unknown, callback?: (error: Error | null) => void): boolean {
    this.sent.push(message);
    callback?.(null);
    if (
      message !== null &&
      typeof message === 'object' &&
      Reflect.get(message, 'type') === 'benchmark_trace_barrier'
    ) {
      queueMicrotask(() =>
        this.emit('message', {
          type: 'benchmark_trace_barrier_done',
          id: Reflect.get(message, 'id'),
        }),
      );
    }
    return true;
  }
}

function fakeSpawn(): {
  spawn: BridgeSpawn;
  children: FakeBridgeChild[];
  spawnOptions: SpawnOptions[];
  spawned: Promise<FakeBridgeChild>;
} {
  const children: FakeBridgeChild[] = [];
  const spawnOptions: SpawnOptions[] = [];
  let resolveSpawn: (child: FakeBridgeChild) => void = () => undefined;
  const spawned = new Promise<FakeBridgeChild>((resolve) => {
    resolveSpawn = resolve;
  });
  const spawn: BridgeSpawn = (_command, _args, _options: SpawnOptions) => {
    const child = new FakeBridgeChild();
    children.push(child);
    spawnOptions.push(_options);
    resolveSpawn(child);
    return child as unknown as ChildProcess;
  };
  return { spawn, children, spawnOptions, spawned };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('benchmark bridge process', () => {
  it('allocates and releases ephemeral ports', async () => {
    for (const port of [await allocateEphemeralPort(), await allocateEphemeralPort()]) {
      expect(port).toBeGreaterThanOrEqual(1_024);
      expect(port).toBeLessThanOrEqual(65_535);
    }
  });

  it('resolves on the listening announcement, ingests trace records, and stops cleanly', async () => {
    const { spawn, spawnOptions, spawned } = fakeSpawn();
    const pending = startBridge('/entry.js', { spawnImpl: spawn });
    const child = await spawned;
    for (const [stage, offset] of [
      ['run_open', 1],
      ['h2_session_connect', 2],
      ['run_stream_open', 3],
    ] as const) {
      child.stderr.write(
        `${JSON.stringify({ request_id: 'req-test', credential_slot_id: null, backend: 'cursor-api', model: 'composer-2.5', upstream_run_count: 1, stage, offset_ms: offset })}\n`,
      );
    }
    child.stderr.write('not json diagnostic\n');
    child.stdout.write('cursor-ai-bridge listening on http://127.0.0.1:1\n');
    const bridge = await pending;
    expect(bridge.baseUrl).toBe(`http://127.0.0.1:${bridge.port}`);
    expect(spawnOptions[0]?.env?.CURSOR_BRIDGE_AUTO_PROBE_TIMEOUT_MS).toBe('30000');
    expect(bridge.trace()).toEqual({
      runOpens: 1,
      retries: 0,
      retryReasons: [],
      flips: 0,
      activeBackend: 'cursor-api',
      usageSource: 'unknown',
      finalBackendState: 'cursor-api',
      cancelled: false,
      quiescent: false,
    });
    expect(bridge.traceRecords().map((record) => record.stage)).toEqual([
      'run_open',
      'h2_session_connect',
      'run_stream_open',
    ]);
    await bridge.stop();
    expect(child.killCalls).toEqual(['SIGTERM']);
  });

  it('uses an exact IPC barrier before sealing a trial trace join', async () => {
    const child = new FakeIpcBridgeChild();
    const spawn: BridgeSpawn = () => child as unknown as ChildProcess;
    const pending = startBridge('/entry.js', { spawnImpl: spawn });
    child.stdout.write('cursor-ai-bridge listening on http://127.0.0.1:1\n');
    const bridge = await pending;
    const scope = bridge.beginTraceScope();
    for (const stage of ['accepted', 'run_open', 'terminal']) {
      child.emit('message', {
        type: 'benchmark_trace_record',
        record: {
          request_id: 'req-ipc',
          credential_slot_id: null,
          backend: 'cursor-api',
          model: 'composer-2.5',
          upstream_run_count: stage === 'accepted' ? 0 : 1,
          stage,
          offset_ms: stage === 'accepted' ? 0 : 1,
          ...(stage === 'terminal'
            ? {
                usage_source: 'unknown',
                final_backend_state: 'cursor-api',
                cancelled: false,
                quiescent: true,
                terminal: 'success',
              }
            : {}),
        },
      });
    }
    await expect(scope.finish()).resolves.toEqual({
      sequence_start: 1,
      sequence_end: 3,
      request_ids: ['req-ipc'],
      record_count: 3,
      attributed_run_count: 1,
      retry_count: 0,
      retry_reasons: [],
      active_backend: 'cursor-api',
      usage_source: 'unknown',
      final_backend_state: 'cursor-api',
      cancelled: false,
      quiescent: true,
      synchronized: true,
    });
    await bridge.stop();
  });

  it('waits for an attributable run_open and its IPC barrier before authorizing cancellation', async () => {
    const child = new FakeIpcBridgeChild();
    const pending = startBridge('/entry.js', {
      spawnImpl: () => child as unknown as ChildProcess,
    });
    child.stdout.write('cursor-ai-bridge listening on http://127.0.0.1:1\n');
    const bridge = await pending;
    const scope = bridge.beginTraceScope();
    const synchronized = scope.waitForSynchronizedRunOpen(1_000);
    expect(child.sent).toEqual([]);
    child.emit('message', {
      type: 'benchmark_trace_record',
      record: {
        request_id: 'req-cancel',
        credential_slot_id: null,
        backend: 'cursor-api',
        model: 'composer-2.5',
        upstream_run_count: 1,
        stage: 'run_open',
        offset_ms: 1,
      },
    });
    await expect(synchronized).resolves.toBe(true);
    expect(child.sent).toEqual([
      expect.objectContaining({ type: 'benchmark_trace_barrier', id: 1 }),
    ]);
    await bridge.stop();
  });

  it('does not reject startup until the failed benchmark child close is observed', async () => {
    const { spawn, spawned } = fakeSpawn();
    const pending = startBridge('/entry.js', { spawnImpl: spawn });
    const child = await spawned;
    let settled = false;
    void pending.catch(() => {
      settled = true;
    });
    child.exitCode = 1;
    child.emit('exit', 1, null);
    await Promise.resolve();
    expect(settled).toBe(false);
    child.emit('close', 1, null);
    await expect(pending).rejects.toThrow('bridge exited before listening');
  });

  it('aborts a never-listening bridge promptly without waiting for the listen deadline', async () => {
    vi.useFakeTimers();
    const { spawn, spawned } = fakeSpawn();
    const controller = new AbortController();
    const pending = startBridge('/entry.js', {
      spawnImpl: spawn,
      signal: controller.signal,
      startDeadlineMs: 30_000,
    });
    const child = await spawned;
    expect(child.stdout.listenerCount('data')).toBeGreaterThan(0);
    controller.abort();
    await expect(pending).rejects.toThrow('bridge start aborted');
    expect(child.killCalls).toEqual(['SIGKILL']);
  });

  it('treats a repeated abort during start as idempotent', async () => {
    vi.useFakeTimers();
    const { spawn, spawned } = fakeSpawn();
    const controller = new AbortController();
    const pending = startBridge('/entry.js', {
      spawnImpl: spawn,
      signal: controller.signal,
      startDeadlineMs: 30_000,
    });
    const child = await spawned;
    controller.abort();
    controller.abort();
    await expect(pending).rejects.toThrow('bridge start aborted');
    expect(child.killCalls.filter((signal) => signal === 'SIGKILL')).toHaveLength(1);
  });

  it('kills the child when the listen deadline expires', async () => {
    vi.useFakeTimers();
    const { spawn, spawned } = fakeSpawn();
    const pending = startBridge('/entry.js', {
      spawnImpl: spawn,
      startDeadlineMs: 30_000,
    });
    const child = await spawned;
    const rejection = expect(pending).rejects.toThrow('bridge listen deadline exceeded');
    await vi.advanceTimersByTimeAsync(30_000);
    await rejection;
    expect(child.killCalls).toEqual(['SIGKILL']);
  });
});
