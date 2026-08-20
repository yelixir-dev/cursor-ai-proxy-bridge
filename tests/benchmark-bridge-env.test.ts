import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bridgeEnvironment } from '../src/benchmark/bridge-env.js';
import {
  compareBenchmarkAccounts,
  unprovedAccountComparability,
} from '../src/benchmark/account-comparability.js';
import { runBenchmarkCli } from '../src/benchmark/cli.js';
import type { BridgeHandle } from '../src/benchmark/bridge-process.js';
import type { CursorApiCredential } from '../src/backend/cursor-api/credentials.js';

const roots: string[] = [];
const jwt = (subject: string) =>
  `e30.${Buffer.from(JSON.stringify({ sub: subject })).toString('base64url')}.signature`;

const fakeBridge = (): BridgeHandle => ({
  port: 43121,
  baseUrl: 'http://127.0.0.1:43121',
  trace: () => ({
    runOpens: 0,
    retries: 0,
    retryReasons: [],
    flips: 0,
    activeBackend: null,
    usageSource: 'unknown',
    finalBackendState: null,
    cancelled: false,
    quiescent: false,
  }),
  traceRecords: () => [],
  beginTraceScope: () => {
    throw new Error('not expected in this preflight test');
  },
  cleanupReceipt: () => ({
    benchmark_owned_pid: null,
    close_observed: true,
    exit_code: 0,
    exit_signal: null,
  }),
  stop: async () => {},
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('bridge-effective environment for the account preflight', () => {
  it('loads the project .env credential the bridge child would load', async () => {
    const root = await mkdtemp(join(tmpdir(), 'benchmark-bridge-env-'));
    roots.push(root);
    const envFile = join(root, '.env');
    await writeFile(envFile, 'CURSOR_API_KEY=envfile-comparability-key\n', { mode: 0o600 });
    const caller: NodeJS.ProcessEnv = { CURSOR_BRIDGE_DASHBOARD_CONFIG: join(root, 'absent.json') };
    const before = { ...process.env };
    const effective = bridgeEnvironment(caller, envFile);
    expect(effective.CURSOR_API_KEY).toBe('envfile-comparability-key');
    expect(caller.CURSOR_API_KEY).toBeUndefined();
    expect(process.env).toEqual(before);
  });

  it('keeps exported values winning over the file like bridge dotenv semantics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'benchmark-bridge-env-precedence-'));
    roots.push(root);
    const envFile = join(root, '.env');
    await writeFile(envFile, 'CURSOR_API_KEY=from-file\n', { mode: 0o600 });
    const effective = bridgeEnvironment({ CURSOR_API_KEY: 'from-export' }, envFile);
    expect(effective.CURSOR_API_KEY).toBe('from-export');
  });

  it('tolerates a missing env file without changing the environment', () => {
    const caller: NodeJS.ProcessEnv = { CURSOR_BRIDGE_DASHBOARD_CONFIG: '/absent/dashboard.json' };
    const effective = bridgeEnvironment(caller, '/absent/.env');
    expect(effective).toEqual(caller);
  });

  it('resolves the .env credential before comparing subjects instead of reporting it missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'benchmark-bridge-env-contract-'));
    roots.push(root);
    const envFile = join(root, '.env');
    await writeFile(envFile, 'CURSOR_API_KEY=envfile-comparability-key\n', { mode: 0o600 });
    const exchanged: CursorApiCredential[] = [];
    const receipt = await compareBenchmarkAccounts(
      jwt('shared-private-subject'),
      bridgeEnvironment({ CURSOR_BRIDGE_DASHBOARD_CONFIG: join(root, 'absent.json') }, envFile),
      undefined,
      {
        authProvider: () => ({
          getToken: async (credential) => {
            if (credential !== undefined) exchanged.push(credential);
            return jwt('shared-private-subject');
          },
        }),
      },
    );
    expect(exchanged.map((credential) => credential.apiKey)).toEqual(['envfile-comparability-key']);
    expect(receipt).toMatchObject({
      status: 'matched',
      reason: 'stable_claim_equal',
      bridge_exchange_available: true,
    });
    expect(JSON.stringify(receipt)).not.toContain('envfile-comparability-key');
  });

  it('reports a .env plus dashboard credential combination as ambiguous, not silently resolved', async () => {
    const root = await mkdtemp(join(tmpdir(), 'benchmark-bridge-env-ambiguous-'));
    roots.push(root);
    const envFile = join(root, '.env');
    const dashboardFile = join(root, 'dashboard.json');
    await Promise.all([
      writeFile(envFile, 'CURSOR_API_KEY=envfile-comparability-key\n', { mode: 0o600 }),
      writeFile(
        dashboardFile,
        JSON.stringify({
          credentials: [
            {
              id: 'dashboard-slot',
              apiKey: 'dashboard-comparability-key',
              weight: 1,
              enabled: true,
            },
          ],
        }),
        { mode: 0o600 },
      ),
    ]);
    const effective = bridgeEnvironment({ CURSOR_BRIDGE_DASHBOARD_CONFIG: dashboardFile }, envFile);
    const receipt = await compareBenchmarkAccounts(jwt('native-private-subject'), effective);
    expect(receipt).toMatchObject({
      status: 'unproved',
      reason: 'bridge_credential_ambiguous',
      account_mismatch: true,
      latency_confounded: true,
    });
    expect(JSON.stringify(receipt)).not.toMatch(
      /envfile-comparability-key|dashboard-comparability-key/,
    );
  });
});

describe('benchmark CLI preflight wiring', () => {
  it('passes the bridge-effective environment to the account comparison', async () => {
    const root = await mkdtemp(join(tmpdir(), 'benchmark-bridge-env-cli-'));
    roots.push(root);
    const authStorePath = join(root, 'auth.json');
    const modelStorePath = join(root, 'models-store.json');
    const comparatorParent = join(process.cwd(), '.omo', 'comparators');
    await mkdir(comparatorParent, { recursive: true });
    const comparatorRoot = await mkdtemp(join(comparatorParent, 'bridge-env-test-'));
    roots.push(comparatorRoot);
    const comparator = join(comparatorRoot, 'omo');
    await Promise.all([
      writeFile(
        authStorePath,
        JSON.stringify({
          cursor: {
            type: 'oauth',
            access: jwt('native-subject'),
            refresh: 'fixture-refresh',
            expires: 4_102_444_800_000,
          },
        }),
        { mode: 0o600 },
      ),
      writeFile(modelStorePath, '{}', { mode: 0o600 }),
      writeFile(comparator, '#!/bin/sh\nexit 0\n', { mode: 0o755 }),
    ]);
    const effectiveEnv: NodeJS.ProcessEnv = { CURSOR_API_KEY: 'from-env-file' };
    const bridgeEnvironmentSpy = vi.fn(() => effectiveEnv);
    const compareAccounts = vi.fn(async (_native: string, _environment: NodeJS.ProcessEnv) =>
      unprovedAccountComparability('dry_run'),
    );
    const cliEnv: NodeJS.ProcessEnv = {
      ...process.env,
      CURSOR_BENCH_AUTH_STORE: authStorePath,
      CURSOR_BENCH_MODEL_STORE: modelStorePath,
      CURSOR_BENCH_OMO_BIN: comparator,
      CURSOR_BENCH_TEMP_ROOT: join(root, 'temp'),
    };
    await expect(
      runBenchmarkCli(
        ['--case', 'text_sentinel_stream', '--output', join(root, 'result.json')],
        cliEnv,
        {
          startBridge: vi.fn(async () => fakeBridge()),
          fetchHealth: vi.fn(async () => ({
            ok: true,
            activeBackend: 'cursor-api',
            bridgeVersion: 'test',
          })),
          compareAccounts,
          bridgeEnvironment: bridgeEnvironmentSpy,
          runBenchmark: vi.fn(async () => {
            throw new Error('stop after preflight');
          }),
          makeExecutor: vi.fn(),
          reportError: () => {},
        },
      ),
    ).rejects.toThrow('stop after preflight');
    expect(bridgeEnvironmentSpy).toHaveBeenCalledWith(cliEnv);
    expect(compareAccounts.mock.calls[0]?.[1]).toBe(effectiveEnv);
  });
});
