import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runBenchmarkCli } from '../src/benchmark/cli.js';

const roots: string[] = [];
const SECRET_SENTINEL = 'R6_CREDENTIAL_VALUE_MUST_NOT_APPEAR';
const VALID_CURSOR = {
  type: 'oauth',
  access: 'fixture-access',
  refresh: 'fixture-refresh',
  expires: 4_102_444_800_000,
};
const authWith = (cursor: unknown): string => JSON.stringify({ cursor });
const INVALID_CLI_AUTH = [
  ['top-level scalar', '42'],
  ['top-level null', 'null'],
  ['top-level array', '[]'],
  ['missing cursor', JSON.stringify({ yorha: { type: 'api_key', key: SECRET_SENTINEL } })],
  ['cursor scalar', authWith(42)],
  ['cursor null', authWith(null)],
  ['cursor array', authWith([])],
  ['unknown cursor type', authWith({ type: 'future_auth', value: SECRET_SENTINEL })],
  [
    'blank access',
    authWith({ type: 'oauth', access: ' ', refresh: 'fixture-refresh', expires: 1 }),
  ],
  [
    'wrong access field type',
    authWith({ type: 'oauth', access: 7, refresh: 'fixture-refresh', expires: 1 }),
  ],
  ['missing refresh', authWith({ type: 'oauth', access: SECRET_SENTINEL, expires: 1 })],
  [
    'wrong expires field type',
    authWith({
      type: 'oauth',
      access: SECRET_SENTINEL,
      refresh: 'fixture-refresh',
      expires: 'tomorrow',
    }),
  ],
] as const;

async function scenario(authContents: string) {
  const root = await mkdtemp(join(tmpdir(), 'benchmark-cli-auth-preflight-'));
  roots.push(root);
  const authStorePath = join(root, 'auth.json');
  const modelStorePath = join(root, 'models-store.json');
  const tempRoot = join(root, 'temp');
  const output = join(root, 'output', 'result.json');
  await Promise.all([
    writeFile(authStorePath, authContents, { mode: 0o600 }),
    writeFile(modelStorePath, '{}', { mode: 0o600 }),
  ]);
  const startBridge = vi.fn();
  const runBenchmark = vi.fn();
  const makeExecutor = vi.fn();
  const errors: string[] = [];
  const code = await runBenchmarkCli(
    ['--profile', 'smoke', '--case', 'text_sentinel_stream', '--output', output],
    {
      ...process.env,
      CURSOR_BENCH_AUTH_STORE: authStorePath,
      CURSOR_BENCH_MODEL_STORE: modelStorePath,
      CURSOR_BENCH_TEMP_ROOT: tempRoot,
    },
    {
      startBridge,
      runBenchmark,
      makeExecutor,
      reportError: (message) => errors.push(message),
    },
  );
  return {
    root,
    output,
    tempRoot,
    code,
    startBridge,
    runBenchmark,
    makeExecutor,
    errors,
  };
}

async function taskOwnedComparator(): Promise<string> {
  const parent = join(process.cwd(), '.omo', 'comparators');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'auth-preflight-test-'));
  roots.push(root);
  const executable = join(root, 'omo');
  await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return executable;
}

async function preseedStale(output: string): Promise<string[]> {
  const base = output.slice(0, -5);
  const paths = [
    output,
    `${base}.md`,
    `${base}.bridge-trace.jsonl`,
    `${base}.versions-environment.json`,
    `${base}.command-exit.json`,
    `${base}.cleanup.json`,
  ];
  await mkdir(output.slice(0, output.lastIndexOf('/')), { recursive: true });
  await Promise.all(paths.map((path) => writeFile(path, 'STALE_PASS')));
  return paths;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('compiled benchmark CLI auth ordering', () => {
  it.each(INVALID_CLI_AUTH)(
    'rejects %s before bridge, executor, or trial construction',
    async (_name, authContents) => {
      const result = await scenario(authContents);
      expect(result.code).toBe(2);
      expect(result.startBridge).not.toHaveBeenCalled();
      expect(result.makeExecutor).not.toHaveBeenCalled();
      expect(result.runBenchmark).not.toHaveBeenCalled();
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('benchmark auth store');
      expect(result.errors[0]).not.toContain(SECRET_SENTINEL);
      await expect(readFile(result.output, 'utf8')).rejects.toThrow();
      const receipt = JSON.parse(
        await readFile(result.output.replace(/\.json$/, '.command-exit.json'), 'utf8'),
      );
      expect(receipt).toEqual({
        schema_version: 'cursor-composer-parity-command-exit/v1',
        completed: true,
        exit_code: 2,
        verdict: 'infra_fail',
        stage: 'preflight',
      });
      expect(
        (await readdir(join(result.root, 'output'))).filter((name) => name.startsWith('result.')),
      ).toEqual(['result.command-exit.json']);
      await expect(readdir(result.tempRoot)).rejects.toThrow();
    },
  );

  it('replaces a stale artifact set in the exact null-auth preflight repro', async () => {
    const root = await mkdtemp(join(tmpdir(), 'benchmark-cli-auth-stale-'));
    roots.push(root);
    const output = join(root, 'output', 'result.json');
    await writeFile(join(root, 'auth.json'), 'null', { mode: 0o600 });
    await writeFile(join(root, 'models-store.json'), '{}', { mode: 0o600 });
    const stale = await preseedStale(output);
    const startBridge = vi.fn();
    const runBenchmark = vi.fn();
    const makeExecutor = vi.fn();
    const errors: string[] = [];
    const code = await runBenchmarkCli(
      ['--case', 'text_sentinel_stream', '--output', output],
      {
        ...process.env,
        CURSOR_BENCH_AUTH_STORE: join(root, 'auth.json'),
        CURSOR_BENCH_MODEL_STORE: join(root, 'models-store.json'),
        CURSOR_BENCH_TEMP_ROOT: join(root, 'temp'),
      },
      {
        startBridge,
        runBenchmark,
        makeExecutor,
        reportError: (message) => errors.push(message),
      },
    );
    expect(code).toBe(2);
    expect(startBridge).not.toHaveBeenCalled();
    expect(makeExecutor).not.toHaveBeenCalled();
    expect(runBenchmark).not.toHaveBeenCalled();
    expect(errors).toHaveLength(1);
    for (const path of stale.filter((path) => !path.endsWith('.command-exit.json'))) {
      await expect(readFile(path, 'utf8')).rejects.toThrow();
    }
    expect(
      JSON.parse(await readFile(join(root, 'output', 'result.command-exit.json'), 'utf8')),
    ).toMatchObject({
      exit_code: 2,
      verdict: 'infra_fail',
      stage: 'preflight',
    });
  });

  it('admits valid Cursor OAuth to exactly one bridge start attempt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'benchmark-cli-auth-valid-'));
    roots.push(root);
    const authStorePath = join(root, 'auth.json');
    const modelStorePath = join(root, 'models-store.json');
    const output = join(root, 'result.json');
    await writeFile(authStorePath, JSON.stringify({ cursor: VALID_CURSOR }), { mode: 0o600 });
    await writeFile(modelStorePath, '{}', { mode: 0o600 });
    const startBridge = vi.fn(async () => {
      throw new Error('synthetic bridge stop');
    });
    const errors: string[] = [];
    const comparator = await taskOwnedComparator();
    const code = await runBenchmarkCli(
      ['--case', 'text_sentinel_stream', '--output', output],
      {
        ...process.env,
        CURSOR_BENCH_AUTH_STORE: authStorePath,
        CURSOR_BENCH_MODEL_STORE: modelStorePath,
        CURSOR_BENCH_OMO_BIN: comparator,
      },
      { startBridge, reportError: (message) => errors.push(message) },
    );
    expect(code).toBe(5);
    expect(startBridge).toHaveBeenCalledTimes(1);
    expect(errors).toEqual(['synthetic bridge stop']);
    expect(
      JSON.parse(await readFile(output.replace(/\.json$/, '.command-exit.json'), 'utf8')),
    ).toMatchObject({ exit_code: 5, verdict: 'infra_fail', stage: 'bridge_start' });
  });
});
