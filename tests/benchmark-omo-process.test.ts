import { EventEmitter } from 'node:events';
import { existsSync, readdirSync } from 'node:fs';
import { lstat, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectOmoComparator } from '../src/benchmark/comparator-inspection.js';
import {
  benchmarkEnvironment,
  createBenchmarkFixture,
  ModelStoreError,
} from '../src/benchmark/fixture.js';
import { OmoProcessError, runOmoTrial, type OmoSpawn } from '../src/benchmark/omo-process.js';

const VERSION = 'omo 5.0.0-0.beta.9 (engine: senpi 2026.8.17)\n';
const MODELS = [
  'provider model context max-out thinking images',
  'cursor composer-2.5 200K 64K no no',
  'cursor composer-2.5-fast 200K 64K no no',
].join('\n');

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 654_321;
  killCalls: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killCalls.push(signal);
    return true;
  }

  close(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }
}

function fakeSpawn(
  onSpawn: (
    child: FakeChild,
    args: readonly string[],
    options: SpawnOptions,
    command: string,
  ) => void,
): {
  spawn: OmoSpawn;
  children: FakeChild[];
} {
  const children: FakeChild[] = [];
  const spawn: OmoSpawn = (command, args, options) => {
    const child = new FakeChild();
    children.push(child);
    onSpawn(child, args, options, command);
    return child as unknown as ChildProcess;
  };
  return { spawn, children };
}

function inspection(version = VERSION, models = MODELS) {
  return vi.fn(async (_command: string, args: readonly string[]) =>
    args.includes('--version') ? version : models,
  );
}

const roots: string[] = [];

async function trialOptions() {
  const root = await mkdtemp(join(tmpdir(), 'omo-runner-test-'));
  roots.push(root);
  const authStorePath = join(root, 'auth.json');
  const modelStorePath = join(root, 'models-store.json');
  await Promise.all([
    writeFile(
      authStorePath,
      JSON.stringify({
        cursor: {
          type: 'oauth',
          access: 'fixture-secret',
          refresh: 'fixture-refresh',
          expires: 4_102_444_800_000,
        },
      }),
      {
        mode: 0o600,
      },
    ),
    writeFile(
      modelStorePath,
      `${JSON.stringify({
        cursor: {
          models: [
            {
              id: 'composer-2.5',
              name: 'Dynamic Composer 2.5',
              api: 'cursor-agent',
              provider: 'cursor',
              baseUrl: 'https://model-store-private.invalid',
              contextWindow: 200_000,
              maxTokens: 64_000,
            },
          ],
          checkedAt: 1_786_982_400_000,
          etag: 'sk-model-store-private',
        },
      })}\n`,
      { mode: 0o600 },
    ),
  ]);
  return {
    provider: 'cursor',
    model: 'composer-2.5',
    prompt: 'fixture prompt',
    seed: 'seed-17',
    authStorePath,
    modelStorePath,
    bridgeBaseUrl: 'http://127.0.0.1:9997/v1',
    timeoutMs: 1_000,
    command: '/task-owned/comparator/omo',
    tempRoot: root,
  } as const;
}

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('benchmark fixture isolation', () => {
  it('snapshots the dynamic model catalog read-only and exposes exact native Composer', async () => {
    const options = await trialOptions();
    const sourceBefore = await readFile(options.modelStorePath, 'utf8');
    const first = await createBenchmarkFixture(options);
    const second = await createBenchmarkFixture(options);

    expect(first.cwd).not.toBe(second.cwd);
    expect(first.sessionDir).not.toBe(second.sessionDir);
    expect(await readFile(join(first.cwd, 'fixture.txt'), 'utf8')).toBe(
      await readFile(join(second.cwd, 'fixture.txt'), 'utf8'),
    );
    expect((await lstat(join(first.agentDir, 'auth.json'))).isSymbolicLink()).toBe(false);
    expect(JSON.parse(await readFile(join(first.agentDir, 'auth.json'), 'utf8'))).toEqual({
      cursor: {
        type: 'oauth',
        access: 'fixture-secret',
        refresh: 'fixture-refresh',
        expires: 4_102_444_800_000,
      },
    });
    const models = await readFile(join(first.agentDir, 'models.json'), 'utf8');
    expect(models).not.toContain('fixture-secret');
    expect(models).not.toContain(options.authStorePath);
    expect(Object.keys(JSON.parse(models).providers)).toEqual(['yorha']);
    const snapshotPath = join(first.agentDir, 'models-store.json');
    expect((await lstat(snapshotPath)).isSymbolicLink()).toBe(false);
    expect((await stat(snapshotPath)).mode & 0o222).toBe(0);
    expect(await readFile(snapshotPath, 'utf8')).toBe(sourceBefore);

    const outcome = await inspectOmoComparator(
      'omo',
      benchmarkEnvironment(first, 'fixture-seed'),
      async (_command, args, env) => {
        if (args.includes('--version')) return VERSION;
        const agentDir = env.OMO_CODING_AGENT_DIR;
        if (agentDir === undefined) throw new Error('missing isolated agent directory');
        const catalog: unknown = JSON.parse(
          await readFile(join(agentDir, 'models-store.json'), 'utf8'),
        );
        const cursor = Reflect.get(catalog as object, 'cursor') as {
          models?: Array<{ id?: string }>;
        };
        return cursor.models?.some((model) => model.id === 'composer-2.5')
          ? 'cursor composer-2.5 200K 64K no no\nyorha composer-2.5 200K 16K yes no\n'
          : 'yorha composer-2.5 200K 16K yes no\n';
      },
      1_000,
    );
    expect(outcome.outcome).toBeNull();
    expect(await readFile(options.modelStorePath, 'utf8')).toBe(sourceBefore);

    const unrelated = join(options.tempRoot, 'unrelated.txt');
    await writeFile(unrelated, 'preserve me');
    await first.dispose();
    await second.dispose();
    expect(existsSync(first.rootDir)).toBe(false);
    expect(await readFile(unrelated, 'utf8')).toBe('preserve me');
  });

  it.each([
    ['missing', 'missing-models-store.json'],
    ['malformed', 'malformed-models-store.json'],
  ] as const)('classifies a %s model store before comparator or paid spawn', async (kind, name) => {
    const options = await trialOptions();
    const modelStorePath = join(options.tempRoot, name);
    if (kind === 'malformed') await writeFile(modelStorePath, '{not-json}\n');
    const spawn = vi.fn<OmoSpawn>();
    const commandOutput = inspection();

    await expect(
      runOmoTrial({ ...options, modelStorePath }, { spawn, commandOutput }),
    ).rejects.toMatchObject({
      failureClass: 'missing_model',
    });
    expect(commandOutput).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([
    ['non-array cursor models', { cursor: { models: 'not-an-array' } }],
    ['missing cursor provider', { xai: { models: [] } }],
    [
      'missing cursor model provider metadata',
      { cursor: { models: [{ id: 'composer-2.5', api: 'cursor-agent' }] } },
    ],
  ] as const)('rejects structurally malformed catalog: %s', async (_name, catalog) => {
    const options = await trialOptions();
    const contents = `${JSON.stringify(catalog)}\n`;
    await writeFile(options.modelStorePath, contents);
    await expect(createBenchmarkFixture(options)).rejects.toBeInstanceOf(ModelStoreError);
    expect(await readFile(options.modelStorePath, 'utf8')).toBe(contents);
    const spawn = vi.fn<OmoSpawn>();
    const commandOutput = inspection();

    await expect(runOmoTrial(options, { spawn, commandOutput })).rejects.toMatchObject({
      failureClass: 'missing_model',
    });
    expect(commandOutput).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('OMO JSON process adapter', () => {
  it('records observed comparator versions independently from expected pins', async () => {
    // Given: a comparator whose observed versions differ from the benchmark pins.
    const observed = 'omo 5.0.0-0.beta.10 (engine: senpi 2026.8.18)\n';

    // When: exact version and model inspection runs.
    const inspectionResult = await inspectOmoComparator(
      '/task-owned/comparator/omo',
      {},
      inspection(observed),
      1_000,
    );

    // Then: the mismatch retains the observed machine versions verbatim.
    expect(inspectionResult).toEqual({
      outcome: 'harness_version_mismatch',
      observedVersionString: observed.trim(),
      observedOmoVersion: '5.0.0-0.beta.10',
      observedSenpiVersion: '2026.8.18',
      modelObserved: true,
    });
  });

  it('subscribes before prompt input, parses split JSONL, and removes each trial workspace', async () => {
    vi.stubEnv('UNRELATED_BENCHMARK_SECRET', 'must-not-reach-child');
    const observedCwds: string[] = [];
    const observedCommands: string[] = [];
    let subscribedBeforeInput = false;
    let promptInput = '';
    const { spawn } = fakeSpawn((child, args, spawnOptions, command) => {
      observedCommands.push(command);
      const cwd = String(spawnOptions.cwd);
      observedCwds.push(cwd);
      child.stdin.on('data', (chunk: Buffer) => {
        promptInput += chunk.toString('utf8');
      });
      child.stdin.once('finish', () => {
        subscribedBeforeInput =
          child.stdout.listenerCount('data') > 0 && child.listenerCount('close') > 0;
        expect(spawnOptions.env?.UNRELATED_BENCHMARK_SECRET).toBeUndefined();
        expect(args).toEqual(
          expect.arrayContaining([
            '--mode',
            'json',
            '--print',
            '--provider',
            'cursor',
            '--model',
            'composer-2.5',
            '--session-dir',
          ]),
        );
        child.stdout.write('{"type":"agent_');
        child.stdout.write(
          `start","cwd":${JSON.stringify(cwd)},"auth":"fixture-secret","model":"sk-model-store-private"}\n{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"ok"}}\n`,
        );
        child.stderr.write(
          `Authorization: Bearer bearer-value ${cwd} ${options.authStorePath} ${options.modelStorePath} fixture-secret sk-model-store-private`,
        );
        child.stdout.end('{"type":"message_end","message":{"role":"assistant"}}\n');
        child.close(0);
      });
    });
    const options = await trialOptions();

    const commandOutput = inspection();
    const result = await runOmoTrial(options, {
      spawn,
      commandOutput,
    });

    expect(commandOutput.mock.calls.every(([command]) => command === options.command)).toBe(true);
    expect(observedCommands).toEqual([options.command]);
    expect(subscribedBeforeInput).toBe(true);
    expect(promptInput).toBe(options.prompt);
    expect(result.events.map((event) => event.value.type)).toEqual([
      'agent_start',
      'message_update',
      'message_end',
    ]);
    expect(
      result.events.every((event, index, all) => {
        if (index === 0) return true;
        const previous = all[index - 1];
        return previous !== undefined && event.atMs >= previous.atMs;
      }),
    ).toBe(true);
    expect(result.exit).toEqual({ code: 0, signal: null });
    const evidenceText = JSON.stringify(result);
    expect(evidenceText).not.toContain(observedCwds.at(0) ?? 'missing-cwd');
    expect(evidenceText).not.toContain('fixture-secret');
    expect(evidenceText).not.toContain('sk-model-store-private');
    expect(result.diagnostics).not.toContain('bearer-value');
    expect(result.diagnostics).not.toContain(options.authStorePath);
    expect(result.diagnostics).not.toContain(options.modelStorePath);
    expect(result.diagnostics).not.toContain('fixture-secret');
    expect(result.diagnostics).not.toContain('sk-model-store-private');
    const removedCwd = observedCwds.at(0);
    expect(removedCwd && existsSync(removedCwd)).toBe(false);
  });

  it.each([
    ['bad complete line', '{bad}\n', 'malformed_jsonl'],
    ['partial line at exit', '{"type":"agent_', 'malformed_jsonl'],
    ['zero exit without terminal', '{"type":"agent_start"}\n', 'early_exit'],
    ['success output with nonzero exit', '{"type":"message_end"}\n', 'early_exit'],
  ] as const)('classifies %s distinctly', async (_name, output, failureClass) => {
    const { spawn } = fakeSpawn((child) => {
      child.stdin.once('finish', () => {
        child.stdout.write(output);
        child.close(failureClass === 'early_exit' && output.includes('message_end') ? 9 : 0);
      });
    });
    const promise = runOmoTrial(await trialOptions(), {
      spawn,
      commandOutput: inspection(),
      signalProcessTree(child) {
        (child as unknown as FakeChild).close(null, 'SIGTERM');
      },
    });
    const error = await promise.catch((reason: unknown) => reason);
    expect(error).toMatchObject({ failureClass });
    expect(error).toHaveProperty('details.exit');
  });

  it.each([
    ['stdout', { maxStdoutBytes: 32 }, 'stdout_overflow'],
    ['stderr', { maxStderrBytes: 32 }, 'stderr_overflow'],
  ] as const)(
    'terminates with a secret-safe typed failure when %s exceeds its byte limit',
    async (stream, limits, failureClass) => {
      // Given: a comparator child that exceeds one configured output limit.
      const signals: NodeJS.Signals[] = [];
      const { spawn } = fakeSpawn((child) => {
        child.stdin.once('finish', () => {
          const output = 'Authorization: Bearer output-limit-private-value';
          if (stream === 'stdout') child.stdout.write(output);
          else child.stderr.write(output);
        });
      });

      // When: the bounded process adapter receives the oversized output.
      const error = await runOmoTrial(await trialOptions(), {
        spawn,
        commandOutput: inspection(),
        ...limits,
        signalProcessTree(child, signal) {
          signals.push(signal);
          queueMicrotask(() => (child as unknown as FakeChild).close(null, signal));
        },
        isProcessTreeAlive: () => false,
      }).catch((reason: unknown) => reason);

      // Then: the adapter terminates the child and retains no secret-bearing receipt.
      expect(error).toMatchObject({ failureClass });
      expect(signals).toEqual(['SIGTERM']);
      expect(JSON.stringify(error)).not.toContain('output-limit-private-value');
    },
  );

  it('times out event-driven, escalates cleanup, and does not confuse a partial frame with bad JSON', async () => {
    vi.useFakeTimers();
    const signals: NodeJS.Signals[] = [];
    const spawned = Promise.withResolvers<void>();
    const { spawn } = fakeSpawn((child) => {
      spawned.resolve();
      child.stdin.once('finish', () => child.stdout.write('{"type":"agent_'));
    });
    const promise = runOmoTrial(await trialOptions(), {
      spawn,
      commandOutput: inspection(),
      terminationGraceMs: 25,
      signalProcessTree(child, signal) {
        signals.push(signal);
        if (signal === 'SIGKILL') {
          queueMicrotask(() => (child as unknown as FakeChild).close(null, signal));
        }
      },
      isProcessTreeAlive: () => false,
    });
    const rejection = promise.catch((error: unknown) => error);
    await spawned.promise;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(signals).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(25);
    await expect(rejection).resolves.toMatchObject({ failureClass: 'timeout' });
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('bounds cleanup when a hung process ignores both signals', async () => {
    vi.useFakeTimers();
    const signals: NodeJS.Signals[] = [];
    const spawned = Promise.withResolvers<void>();
    const { spawn } = fakeSpawn(() => spawned.resolve());
    const promise = runOmoTrial(await trialOptions(), {
      spawn,
      commandOutput: inspection(),
      terminationGraceMs: 25,
      signalProcessTree(_child, signal) {
        signals.push(signal);
      },
    });
    const rejection = promise.catch((error: unknown) => error);
    await spawned.promise;
    await vi.advanceTimersByTimeAsync(1_050);
    await expect(rejection).resolves.toMatchObject({
      failureClass: 'lingering_descendant',
    });
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('aborts an active process tree idempotently', async () => {
    const controller = new AbortController();
    const signals: NodeJS.Signals[] = [];
    const spawned = Promise.withResolvers<void>();
    const { spawn } = fakeSpawn(() => spawned.resolve());
    const promise = runOmoTrial(
      { ...(await trialOptions()), signal: controller.signal },
      {
        spawn,
        commandOutput: inspection(),
        signalProcessTree(child, signal) {
          signals.push(signal);
          queueMicrotask(() => (child as unknown as FakeChild).close(null, signal));
        },
        isProcessTreeAlive: () => false,
      },
    );
    await spawned.promise;
    controller.abort();
    controller.abort();
    await expect(promise).rejects.toMatchObject({
      failureClass: 'cancel_failed',
    });
    expect(signals).toEqual(['SIGTERM']);
  });

  it('cleans a descendant after successful child exit without misclassifying the trial', async () => {
    const signals: NodeJS.Signals[] = [];
    let alive = true;
    const { spawn } = fakeSpawn((child) => {
      child.stdin.once('finish', () => {
        child.stdout.end('{"type":"message_end"}\n');
        child.close(0);
      });
    });
    const promise = runOmoTrial(await trialOptions(), {
      spawn,
      commandOutput: inspection(),
      isProcessTreeAlive: () => alive,
      signalProcessTree(_child, signal) {
        signals.push(signal);
        alive = false;
      },
    });
    await expect(promise).resolves.toMatchObject({
      exit: { code: 0, signal: null },
    });
    expect(signals).toEqual(['SIGKILL']);
    expect(alive).toBe(false);
  });

  it('reports a descendant only when it remains after benchmark-owned cleanup', async () => {
    const signals: NodeJS.Signals[] = [];
    const { spawn } = fakeSpawn((child) => {
      child.stdin.once('finish', () => {
        child.stdout.end('{"type":"message_end"}\n');
        child.close(0);
      });
    });
    const promise = runOmoTrial(await trialOptions(), {
      spawn,
      commandOutput: inspection(),
      isProcessTreeAlive: () => true,
      signalProcessTree(_child, signal) {
        signals.push(signal);
      },
    });
    await expect(promise).rejects.toMatchObject({
      failureClass: 'lingering_descendant',
    });
    expect(signals).toEqual(['SIGKILL']);
  });

  it.each([
    ['omo 5.0.0 (engine: senpi 2026.8.17)\n', MODELS, 'harness_version_mismatch'],
    [VERSION, 'cursor composer-2.5-fast 200K 64K no no\n', 'missing_model'],
  ] as const)(
    'rejects incompatible harness/model inspection',
    async (version, models, failureClass) => {
      const spawn = vi.fn<OmoSpawn>();
      const promise = runOmoTrial(await trialOptions(), {
        spawn,
        commandOutput: inspection(version, models),
      });
      await expect(promise).rejects.toMatchObject({ failureClass });
      expect(spawn).not.toHaveBeenCalled();
    },
  );

  it('bounds a hung comparator preflight with immediate repeated abort and cleans up', async () => {
    vi.useFakeTimers();
    const comparatorSignals: AbortSignal[] = [];
    const firstInspection = Promise.withResolvers<void>();
    const commandOutput = vi.fn(
      (
        _command: string,
        _args: readonly string[],
        _env: NodeJS.ProcessEnv,
        signal: AbortSignal,
      ) => {
        comparatorSignals.push(signal);
        firstInspection.resolve();
        return new Promise<string>(() => {});
      },
    );
    const spawn = vi.fn<OmoSpawn>();
    const controller = new AbortController();
    const options = await trialOptions();

    const promise = runOmoTrial(
      { ...options, timeoutMs: 20, signal: controller.signal },
      { spawn, commandOutput },
    );
    const rejection = promise.catch((error: unknown) => error);
    await firstInspection.promise;
    controller.abort();
    controller.abort();
    const error = await rejection;

    expect(error).toMatchObject({ failureClass: 'cancel_failed' });
    expect(spawn).not.toHaveBeenCalled();
    expect(comparatorSignals.length).toBeGreaterThan(0);
    expect(comparatorSignals.every((signal) => signal.aborted)).toBe(true);
    expect(
      readdirSync(options.tempRoot).filter((entry) =>
        entry.startsWith('cursor-composer-benchmark-'),
      ),
    ).toEqual([]);
  });

  it('reports preflight timeout and aborts hung comparator subprocesses', async () => {
    vi.useFakeTimers();
    const comparatorSignals: AbortSignal[] = [];
    const firstInspection = Promise.withResolvers<void>();
    const commandOutput = vi.fn(
      (
        _command: string,
        _args: readonly string[],
        _env: NodeJS.ProcessEnv,
        signal: AbortSignal,
      ) => {
        comparatorSignals.push(signal);
        firstInspection.resolve();
        return new Promise<string>(() => {});
      },
    );
    const spawn = vi.fn<OmoSpawn>();
    const options = await trialOptions();

    const promise = runOmoTrial({ ...options, timeoutMs: 20 }, { spawn, commandOutput });
    const rejection = promise.catch((error: unknown) => error);
    await firstInspection.promise;
    await vi.advanceTimersByTimeAsync(20);
    const error = await rejection;

    expect(error).toMatchObject({ failureClass: 'timeout' });
    expect(spawn).not.toHaveBeenCalled();
    expect(comparatorSignals.every((signal) => signal.aborted)).toBe(true);
    expect(
      readdirSync(options.tempRoot).filter((entry) =>
        entry.startsWith('cursor-composer-benchmark-'),
      ),
    ).toEqual([]);
  });

  it('cancels the sibling comparator inspection when the first one fails', async () => {
    let modelSignal: AbortSignal | undefined;
    const commandOutput = vi.fn(
      (_command: string, args: readonly string[], _env: NodeJS.ProcessEnv, signal: AbortSignal) => {
        if (args.includes('--list-models')) modelSignal = signal;
        return args.includes('--version')
          ? Promise.reject(new Error('inspection failed'))
          : new Promise<string>(() => {});
      },
    );
    const options = await trialOptions();

    await expect(runOmoTrial(options, { commandOutput })).rejects.toMatchObject({
      failureClass: 'harness_version_mismatch',
    });
    expect(modelSignal?.aborted).toBe(true);
    expect(
      readdirSync(options.tempRoot).filter((entry) =>
        entry.startsWith('cursor-composer-benchmark-'),
      ),
    ).toEqual([]);
  });

  it('rejects the fast Composer id even when it is installed', async () => {
    const options = { ...(await trialOptions()), model: 'composer-2.5-fast' };
    const first = runOmoTrial(options, { commandOutput: inspection() });
    await expect(first).rejects.toBeInstanceOf(OmoProcessError);
    const second = runOmoTrial(options, { commandOutput: inspection() });
    await expect(second).rejects.toMatchObject({
      failureClass: 'missing_model',
    });
  });
});
