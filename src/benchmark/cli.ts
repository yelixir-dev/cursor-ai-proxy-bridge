#!/usr/bin/env node
import { access, readFile } from 'node:fs/promises';
import { compareBenchmarkAccounts } from './account-comparability.js';
import { bridgeEnvironment } from './bridge-env.js';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  invalidateBenchmarkArtifacts,
  outputCompanionFiles,
  writeBenchmarkArtifacts,
  writeBenchmarkFailureReceipt,
} from './artifacts.js';
import { fetchHealth, startBridge } from './bridge-process.js';
import { createCanonicalCases } from './cases.js';
import { CliUsageError, parseBenchmarkArgs } from './cli-args.js';
import type { OmoComparatorInspection } from './comparator-inspection.js';
import { resolveBenchmarkComparator } from './comparator.js';
import { makeExecutor } from './executor.js';
import { parseNativeCursorAuthContents } from './fixture-auth.js';
import { type BenchmarkRunResult, runBenchmark } from './runner.js';

export { CliUsageError, parseBenchmarkArgs } from './cli-args.js';

export interface BenchmarkCliDependencies {
  startBridge: typeof startBridge;
  fetchHealth: typeof fetchHealth;
  runBenchmark: typeof runBenchmark;
  makeExecutor: typeof makeExecutor;
  compareAccounts: typeof compareBenchmarkAccounts;
  bridgeEnvironment: typeof bridgeEnvironment;
  reportError(message: string): void;
}

const DEFAULT_DEPENDENCIES: BenchmarkCliDependencies = {
  startBridge,
  fetchHealth,
  runBenchmark,
  makeExecutor,
  compareAccounts: compareBenchmarkAccounts,
  bridgeEnvironment,
  reportError: (message) => console.error(message),
};

function printSchedule(result: BenchmarkRunResult): void {
  console.log(`scheduled ${result.schedule.length} pairs:`);
  result.schedule.forEach((entry, index) => {
    console.log(
      `  pair ${index + 1}: ${entry.caseId}#${entry.pairIndex} [${entry.phase}] ${entry.lanes.join(' -> ')}`,
    );
  });
}

function verdictExitCode(verdict: string): number {
  if (verdict === 'pass') return 0;
  if (verdict === 'quota_stop') return 3;
  if (verdict === 'infra_fail') return 4;
  return 1;
}

export async function runBenchmarkCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<BenchmarkCliDependencies> = {},
): Promise<number> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const options = parseBenchmarkArgs(argv);
  await invalidateBenchmarkArtifacts(options.output);
  const allCases = createCanonicalCases();
  const cases = options.caseIds
    ? allCases.filter((testCase) => options.caseIds?.includes(testCase.id))
    : allCases;
  const controller = new AbortController();
  const requestStop = (): void => controller.abort();
  process.on('SIGINT', requestStop);
  process.on('SIGTERM', requestStop);
  const runOptions = {
    seed: options.seed,
    profile: options.profile,
    cases,
    dryRun: options.dryRun,
    signal: controller.signal,
    companionFiles: outputCompanionFiles(options.output),
  };
  try {
    if (options.dryRun) {
      const result = await dependencies.runBenchmark(runOptions, {
        executeTrial: () => {
          throw new Error('dry-run must not execute trials');
        },
      });
      printSchedule(result);
      const paths = await writeBenchmarkArtifacts(options.output, result, {
        traceRecords: [],
        bridgeCleanup: null,
        exitCode: 0,
        tempRoot: env.CURSOR_BENCH_TEMP_ROOT ?? tmpdir(),
      });
      console.log(`dry run complete: ${paths.jsonPath}`);
      console.log(`markdown report: ${paths.markdownPath}`);
      console.log('no network calls were made; verdict is intentionally not a pass');
      return 0;
    }
    const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const defaultAgentDir = join(homedir(), '.omo', 'agent');
    const authStorePath = resolve(
      env.CURSOR_BENCH_AUTH_STORE ?? join(defaultAgentDir, 'auth.json'),
    );
    const modelStorePath = resolve(
      env.CURSOR_BENCH_MODEL_STORE ?? join(defaultAgentDir, 'models-store.json'),
    );
    for (const [label, path] of [
      ['auth', authStorePath],
      ['model', modelStorePath],
    ] as const) {
      try {
        await access(path);
      } catch {
        dependencies.reportError(`benchmark ${label} store not found: ${path}`);
        await writeBenchmarkFailureReceipt(options.output, 2, 'preflight');
        return 2;
      }
    }
    let nativeAccess: string;
    try {
      nativeAccess = parseNativeCursorAuthContents(await readFile(authStorePath, 'utf8')).cursor
        .access;
    } catch {
      dependencies.reportError('benchmark auth store is invalid');
      await writeBenchmarkFailureReceipt(options.output, 2, 'preflight');
      return 2;
    }
    const comparator = await resolveBenchmarkComparator(env.CURSOR_BENCH_OMO_BIN, projectRoot);
    if (!comparator.ok) {
      dependencies.reportError(
        `benchmark comparator preflight failed: ${comparator.reason}; expected task-owned executable under ${comparator.expectedRoot}`,
      );
      await writeBenchmarkFailureReceipt(options.output, 2, 'preflight', {
        reason: comparator.reason,
        expected_root: comparator.expectedRoot,
      });
      return 2;
    }
    const entry = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'index.js');
    const bridge = await dependencies
      .startBridge(entry, {
        signal: controller.signal,
      })
      .catch(async (error: unknown) => {
        dependencies.reportError(error instanceof Error ? error.message : 'bridge failed to start');
        await writeBenchmarkFailureReceipt(options.output, 5, 'bridge_start');
        return null;
      });
    if (bridge === null) return 5;
    const tempRoot = env.CURSOR_BENCH_TEMP_ROOT ?? tmpdir();
    let comparatorInspection: OmoComparatorInspection | null = null;
    let result: BenchmarkRunResult | undefined;
    let runError: unknown;
    try {
      const health = await dependencies.fetchHealth(bridge.baseUrl);
      const accountComparability = await dependencies.compareAccounts(
        nativeAccess,
        dependencies.bridgeEnvironment(env),
        controller.signal,
      );
      result = await dependencies.runBenchmark(runOptions, {
        preflight: async () => ({ ...health, accountComparability }),
        executeTrial: dependencies.makeExecutor({
          bridge,
          authStorePath,
          modelStorePath,
          omoBin: comparator.executable,
          trialTimeoutMs: Number(env.CURSOR_BENCH_TRIAL_TIMEOUT_MS ?? 240_000),
          cancellationBarrierTimeoutMs: Number(
            env.CURSOR_BENCH_CANCELLATION_BARRIER_TIMEOUT_MS ?? 10_000,
          ),
          tempRoot,
          signal: controller.signal,
          onComparatorInspection: (inspection) => {
            comparatorInspection = inspection;
          },
        }),
      });
    } catch (error) {
      runError = error;
    } finally {
      await bridge.stop();
    }
    if (!result) {
      await writeBenchmarkFailureReceipt(options.output, 5, 'preflight');
      throw runError;
    }
    const exitCode = verdictExitCode(result.evidence.verdict);
    const paths = await writeBenchmarkArtifacts(options.output, result, {
      traceRecords: bridge.traceRecords(),
      bridgeCleanup: bridge.cleanupReceipt(),
      exitCode,
      tempRoot,
      comparator: {
        executable: comparator,
        inspection: comparatorInspection,
      },
    });
    console.log(`verdict: ${result.evidence.verdict}`);
    console.log(`evidence: ${paths.jsonPath}`);
    console.log(`markdown report: ${paths.markdownPath}`);
    for (const path of paths.companionPaths) console.log(`companion: ${path}`);
    return exitCode;
  } finally {
    process.removeListener('SIGINT', requestStop);
    process.removeListener('SIGTERM', requestStop);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  runBenchmarkCli(process.argv.slice(2), process.env)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      if (error instanceof CliUsageError) {
        console.error(error.message);
        process.exitCode = 2;
      } else {
        console.error(error);
        process.exitCode = 5;
      }
    });
}
