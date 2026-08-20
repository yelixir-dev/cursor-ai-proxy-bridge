import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BridgeHandle } from '../src/benchmark/bridge-process.js';
import { runBenchmarkCli } from '../src/benchmark/cli.js';

const roots: string[] = [];

async function cliFixture(comparator?: string) {
  const root = await mkdtemp(join(tmpdir(), 'benchmark-comparator-cli-'));
  roots.push(root);
  const authStorePath = join(root, 'auth.json');
  const modelStorePath = join(root, 'models-store.json');
  const output = join(root, 'result.json');
  await Promise.all([
    writeFile(
      authStorePath,
      JSON.stringify({
        cursor: {
          type: 'oauth',
          access: 'fixture-access',
          refresh: 'fixture-refresh',
          expires: 4_102_444_800_000,
        },
      }),
    ),
    writeFile(modelStorePath, '{}'),
  ]);
  const bridge: BridgeHandle = {
    port: 1,
    baseUrl: 'http://127.0.0.1:1',
    trace: () => ({ runOpens: 0, flips: 0 }),
    traceRecords: () => [],
    beginTraceScope: vi.fn(),
    cleanupReceipt: () => ({
      benchmark_owned_pid: null,
      close_observed: true,
      exit_code: 0,
      exit_signal: null,
    }),
    stop: vi.fn(async () => undefined),
  };
  const startBridge = vi.fn(async () => bridge);
  const makeExecutor = vi.fn(() => vi.fn());
  const runBenchmark = vi.fn(async () => {
    throw new Error('stop after executor construction');
  });
  const errors: string[] = [];
  const env: NodeJS.ProcessEnv = {
    CURSOR_BENCH_AUTH_STORE: authStorePath,
    CURSOR_BENCH_MODEL_STORE: modelStorePath,
    CURSOR_BENCH_TEMP_ROOT: root,
  };
  if (comparator !== undefined) env.CURSOR_BENCH_OMO_BIN = comparator;
  return { root, output, bridge, startBridge, makeExecutor, runBenchmark, errors, env };
}

async function taskOwnedExecutable(mode = 0o755): Promise<string> {
  const parent = join(process.cwd(), '.omo', 'comparators');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'hermeticity-test-'));
  roots.push(root);
  const executable = join(root, 'omo');
  await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode });
  return executable;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('benchmark comparator preflight', () => {
  it('keeps dry-run usable without a comparator but never claims live parity', async () => {
    // Given: a dry benchmark with no comparator environment.
    const root = await mkdtemp(join(tmpdir(), 'benchmark-comparator-dry-'));
    roots.push(root);
    const output = join(root, 'result.json');

    // When: the schedule-only CLI run completes.
    const code = await runBenchmarkCli(
      ['--dry-run', '--profile', 'smoke', '--case', 'text_sentinel_stream', '--output', output],
      {},
    );

    // Then: its versions receipt explicitly disclaims live comparator parity.
    expect(code).toBe(0);
    const versions = JSON.parse(
      await readFile(output.replace(/\.json$/, '.versions-environment.json'), 'utf8'),
    );
    expect(versions).toMatchObject({
      omo_version: null,
      senpi_engine_version: null,
      comparator: null,
      live_comparator_parity_claimed: false,
    });
  });

  it('rejects a missing explicit comparator before bridge, executor, or model work', async () => {
    // Given: a live benchmark environment without CURSOR_BENCH_OMO_BIN.
    const fixture = await cliFixture();
    const startBridge = vi.fn(async () => {
      throw new Error('bridge must remain unreachable');
    });

    // When: the benchmark CLI performs preflight.
    const code = await runBenchmarkCli(
      ['--profile', 'smoke', '--case', 'text_sentinel_stream', '--output', fixture.output],
      fixture.env,
      {
        startBridge,
        makeExecutor: fixture.makeExecutor,
        runBenchmark: fixture.runBenchmark,
        reportError: (message) => fixture.errors.push(message),
      },
    );

    // Then: it emits only a sanitized deterministic preflight receipt.
    expect(code).toBe(2);
    expect(startBridge).not.toHaveBeenCalled();
    expect(fixture.makeExecutor).not.toHaveBeenCalled();
    expect(fixture.runBenchmark).not.toHaveBeenCalled();
    expect(fixture.errors.join('\n')).not.toContain(process.env.HOME ?? 'HOME_NOT_SET');
    const receipt = JSON.parse(
      await readFile(fixture.output.replace(/\.json$/, '.command-exit.json'), 'utf8'),
    );
    expect(receipt).toMatchObject({
      exit_code: 2,
      verdict: 'infra_fail',
      stage: 'preflight',
      comparator: { reason: 'missing_explicit_path' },
    });
  });

  it.each([
    ['relative', 'relative/omo'],
    ['outside task root', '/definitely/not/a/task-owned/executable'],
  ] as const)('rejects a %s comparator before bridge startup', async (_kind, comparator) => {
    // Given: an invalid explicit comparator path.
    const fixture = await cliFixture(comparator);
    const startBridge = vi.fn(async () => {
      throw new Error('bridge must remain unreachable');
    });

    // When: the benchmark CLI performs preflight.
    const code = await runBenchmarkCli(
      ['--profile', 'smoke', '--case', 'text_sentinel_stream', '--output', fixture.output],
      fixture.env,
      {
        startBridge,
        makeExecutor: fixture.makeExecutor,
        runBenchmark: fixture.runBenchmark,
        reportError: (message) => fixture.errors.push(message),
      },
    );

    // Then: no executor or bridge can observe the invalid path.
    expect(code).toBe(2);
    expect(startBridge).not.toHaveBeenCalled();
    expect(fixture.makeExecutor).not.toHaveBeenCalled();
  });

  it('rejects a non-executable file inside the task-owned root', async () => {
    // Given: a task-owned comparator file without execute permission.
    const fixture = await cliFixture(await taskOwnedExecutable(0o644));
    const startBridge = vi.fn(async () => {
      throw new Error('bridge must remain unreachable');
    });

    // When: the benchmark CLI performs preflight.
    const code = await runBenchmarkCli(
      ['--profile', 'smoke', '--case', 'text_sentinel_stream', '--output', fixture.output],
      fixture.env,
      { startBridge, makeExecutor: fixture.makeExecutor, runBenchmark: fixture.runBenchmark },
    );

    // Then: executable validation blocks all downstream work.
    expect(code).toBe(2);
    expect(startBridge).not.toHaveBeenCalled();
    expect(fixture.makeExecutor).not.toHaveBeenCalled();
  });

  it('passes one absolute explicit comparator path to executor construction unchanged', async () => {
    // Given: an explicit path that reaches the existing executor seam.
    const comparator = await taskOwnedExecutable();
    const fixture = await cliFixture(comparator);

    // When: executor construction is reached.
    await expect(
      runBenchmarkCli(
        ['--profile', 'smoke', '--case', 'text_sentinel_stream', '--output', fixture.output],
        fixture.env,
        {
          startBridge: fixture.startBridge,
          fetchHealth: async () => ({
            ok: true,
            activeBackend: 'cursor-api',
            bridgeVersion: 'test',
          }),
          compareAccounts: vi.fn(),
          makeExecutor: fixture.makeExecutor,
          runBenchmark: fixture.runBenchmark,
        },
      ),
    ).rejects.toThrow('stop after executor construction');

    // Then: the exact path is threaded without PATH resolution or rewriting.
    expect(fixture.makeExecutor).toHaveBeenCalledWith(
      expect.objectContaining({ omoBin: comparator }),
    );
  });
});
