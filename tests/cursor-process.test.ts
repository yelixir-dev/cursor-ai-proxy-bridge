import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  childEnvironment,
  createCursorCliBackend,
  createCursorCommandRunner,
  CursorChildRegistry,
  type CursorSpawn,
} from '../src/backend/cursor-cli.js';
import type { BridgeConfig } from '../src/config.js';

const baseConfig: BridgeConfig = {
  host: '127.0.0.1',
  port: 9997,
  apiKey: 'test-key',
  backend: 'cursor-cli',
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

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 987_654;

  kill(): boolean {
    return true;
  }

  exit(signal: NodeJS.Signals = 'SIGTERM'): void {
    this.emit('exit', null, signal);
    this.emit('close', null, signal);
  }
}

function fakeSpawn(
  onSpawn?: (child: FakeChild, options: SpawnOptions, args: readonly string[]) => void,
): {
  spawn: CursorSpawn;
  children: FakeChild[];
} {
  const children: FakeChild[] = [];
  const spawn: CursorSpawn = (_command, args, options) => {
    const child = new FakeChild();
    children.push(child);
    onSpawn?.(child, options, args);
    return child as unknown as ChildProcess;
  };
  return { spawn, children };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('cursor child process lifecycle', () => {
  it('passes only the child environment allowlist by default', () => {
    const env = childEnvironment({
      PATH: '/test/bin',
      HOME: '/test/home',
      CURSOR_AUTH_TOKEN: 'upstream-token',
      CURSOR_BRIDGE_API_KEY: 'bridge-secret',
      DATABASE_PASSWORD: 'database-secret',
      XDG_CACHE_HOME: '/test/cache',
    });

    expect(env.PATH).toBe('/test/bin');
    expect(env.CURSOR_AUTH_TOKEN).toBe('upstream-token');
    expect(env.XDG_CACHE_HOME).toBe('/test/cache');
    expect(env.CURSOR_BRIDGE_API_KEY).toBeUndefined();
    expect(env.DATABASE_PASSWORD).toBeUndefined();
    expect(env.NO_COLOR).toBe('1');
  });

  it('allows explicitly named additional child environment variables', () => {
    const env = childEnvironment({
      CURSOR_BRIDGE_CHILD_ENV_ALLOW: 'HTTPS_PROXY, CUSTOM_RUNTIME_VALUE',
      HTTPS_PROXY: 'http://proxy.test',
      CUSTOM_RUNTIME_VALUE: 'allowed',
      OTHER_SECRET: 'blocked',
    });

    expect(env.HTTPS_PROXY).toBe('http://proxy.test');
    expect(env.CUSTOM_RUNTIME_VALUE).toBe('allowed');
    expect(env.OTHER_SECRET).toBeUndefined();
  });

  it('escalates a timed-out child from SIGTERM to SIGKILL after the grace period', async () => {
    vi.useFakeTimers();
    const { spawn } = fakeSpawn();
    const signals: NodeJS.Signals[] = [];
    const runner = createCursorCommandRunner({
      spawn,
      terminationGraceMs: 750,
      signalChild(child, signal) {
        signals.push(signal);
        if (signal === 'SIGKILL')
          queueMicrotask(() => (child as unknown as FakeChild).exit(signal));
      },
    });

    const command = runner('cursor-agent', ['--print'], '/tmp', 1_000);
    const rejection = expect(command).rejects.toThrow('timed out after 1000ms');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(signals).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(749);
    expect(signals).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('terminates and rejects when combined stdout and stderr exceed the output cap', async () => {
    const { spawn, children } = fakeSpawn();
    const runner = createCursorCommandRunner({
      spawn,
      maxOutputBytes: 8,
      signalChild(child, signal) {
        if (signal === 'SIGTERM')
          queueMicrotask(() => (child as unknown as FakeChild).exit(signal));
      },
    });

    const command = runner('cursor-agent', ['--print'], '/tmp', 1_000);
    children[0]?.stdout.write('12345');
    children[0]?.stderr.write('6789');

    await expect(command).rejects.toThrow('output limit exceeded');
  });

  it('terminates registered children during backend shutdown', async () => {
    const registry = new CursorChildRegistry();
    const { spawn } = fakeSpawn();
    const termSent = deferred();
    const runner = createCursorCommandRunner({
      registry,
      spawn,
      signalChild(child, signal) {
        if (signal === 'SIGTERM') {
          termSent.resolve();
          queueMicrotask(() => (child as unknown as FakeChild).exit(signal));
        }
      },
    });

    const command = runner('cursor-agent', ['--print'], '/tmp', 60_000);
    expect(registry.size).toBe(1);
    const shutdown = registry.shutdown();
    await termSent.promise;
    await shutdown;
    await expect(command).rejects.toThrow('shutting down');
    expect(registry.size).toBe(0);
  });

  it('keeps a temporary workspace until an aborted child has exited', async () => {
    const spawned = deferred<{ child: FakeChild; cwd: string }>();
    const termSent = deferred();
    const { spawn } = fakeSpawn((child, options) => {
      spawned.resolve({ child, cwd: String(options.cwd) });
    });
    const backend = createCursorCliBackend(baseConfig, {
      spawn,
      environment: { PATH: process.env.PATH, CURSOR_BRIDGE_CURSOR_BIN: 'cursor-agent' },
      terminationGraceMs: 10_000,
      signalChild(_child, signal) {
        if (signal === 'SIGTERM') termSent.resolve();
      },
    });
    const controller = new AbortController();

    const completion = backend.complete(
      { model: 'composer-2.5', messages: [{ role: 'user', content: 'wait' }] },
      controller.signal,
    );
    const { child, cwd } = await spawned.promise;
    controller.abort();
    await termSent.promise;
    expect(existsSync(cwd)).toBe(true);

    child.exit('SIGTERM');
    await expect(completion).rejects.toHaveProperty('name', 'AbortError');
    expect(existsSync(cwd)).toBe(false);
  });

  it('streams assistant fragments before process exit and drops the final aggregate duplicate', async () => {
    const spawned = deferred<{ child: FakeChild; args: readonly string[] }>();
    const { spawn } = fakeSpawn((child, _options, args) => spawned.resolve({ child, args }));
    const backend = createCursorCliBackend(baseConfig, {
      spawn,
      environment: { PATH: process.env.PATH, CURSOR_BRIDGE_CURSOR_BIN: 'cursor-agent' },
    });

    const eventStream = backend.completeStream({
      model: 'composer-2.5',
      messages: [{ role: 'user', content: 'stream' }],
    });
    const iterator = eventStream[Symbol.asyncIterator]();
    const firstContent = iterator.next();
    const { child, args } = await spawned.promise;
    expect(args).toEqual(
      expect.arrayContaining(['--output-format', 'stream-json', '--stream-partial-output']),
    );

    child.stdout.write(
      `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'one ' }] }, timestamp_ms: 1 })}\n`,
    );
    child.stdout.write(
      `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'two' }] }, timestamp_ms: 2 })}\n`,
    );
    await expect(firstContent).resolves.toEqual({
      value: { type: 'content', text: 'one ' },
      done: false,
    });

    child.stdout.write(
      `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'one two' }] } })}\n`,
    );
    child.stdout.write(
      `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'one two', usage: { inputTokens: 7, outputTokens: 2 } })}\n`,
    );
    child.emit('exit', 0, null);
    child.emit('close', 0, null);

    const remaining = [];
    while (true) {
      const event = await iterator.next();
      if (event.done) break;
      remaining.push(event.value);
    }
    expect(remaining).toEqual([
      { type: 'content', text: 'two' },
      {
        type: 'done',
        usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
        is_error: false,
      },
    ]);
  });

  it('serializes completions that use the same resolved real workspace', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'cursor-ai-bridge-mutex-'));
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const secondStarted = deferred();
    let calls = 0;
    const backend = createCursorCliBackend(
      { ...baseConfig, workspaceMode: 'real-workspace', realWorkspacePath: workspace },
      {
        commandRunner: async () => {
          calls += 1;
          if (calls === 1) {
            firstStarted.resolve();
            await releaseFirst.promise;
          } else {
            secondStarted.resolve();
          }
          return JSON.stringify({ is_error: false, result: `result-${calls}` });
        },
      },
    );

    const first = backend.complete({
      model: 'composer-2.5',
      messages: [{ role: 'user', content: 'first' }],
    });
    await firstStarted.promise;
    const second = backend.complete({
      model: 'composer-2.5',
      messages: [{ role: 'user', content: 'second' }],
    });
    await Promise.resolve();
    expect(calls).toBe(1);

    releaseFirst.resolve();
    await secondStarted.promise;
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(calls).toBe(2);
  });
});
