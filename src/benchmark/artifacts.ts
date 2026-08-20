import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import type { BridgeCleanupReceipt, SanitizedBridgeTraceRecord } from './bridge-process.js';
import { companionFiles } from './evidence-contract.js';
import {
  PINNED_OMO_VERSION,
  PINNED_SENPI_VERSION,
  type OmoComparatorInspection,
} from './comparator-inspection.js';
import { renderMarkdownReport } from './report.js';
import { isMeasuredTrialFactory, type BenchmarkRunResult } from './runner.js';
import { validateRetainedTraceJoins } from './trace-join.js';

export type ArtifactIoErrorCode = 'artifact_invalidation_failed' | 'cleanup_observation_failed';

export class ArtifactIoError extends Error {
  readonly name = 'ArtifactIoError';

  constructor(
    readonly code: ArtifactIoErrorCode,
    options: { readonly cause?: unknown } = {},
  ) {
    super(`benchmark artifact I/O failed: ${code}`, { cause: options.cause });
  }
}

function isMissingPath(error: unknown): boolean {
  return error !== null && typeof error === 'object' && Reflect.get(error, 'code') === 'ENOENT';
}

export interface ArtifactRuntimeReceipt {
  traceRecords: readonly SanitizedBridgeTraceRecord[];
  bridgeCleanup: BridgeCleanupReceipt | null;
  exitCode: number;
  tempRoot: string;
  comparator?: {
    readonly executable: {
      readonly sanitizedPath: string;
      readonly provenance: 'task_owned_absolute';
    };
    readonly inspection: OmoComparatorInspection | null;
  };
}

export interface ArtifactPaths {
  jsonPath: string;
  markdownPath: string;
  companionPaths: string[];
}

export function artifactBaseName(outputPath: string): string {
  const name = basename(outputPath);
  return name.endsWith('.json') ? name.slice(0, -5) : name;
}

export function outputCompanionFiles(outputPath: string) {
  return companionFiles(artifactBaseName(outputPath));
}

function artifactSetPaths(outputPath: string): string[] {
  const jsonPath = resolve(outputPath);
  const directory = dirname(jsonPath);
  const base = artifactBaseName(jsonPath);
  return [
    jsonPath,
    resolve(directory, `${base}.md`),
    ...companionFiles(base).map((file) => resolve(directory, file.path)),
  ];
}

export async function invalidateBenchmarkArtifacts(outputPath: string): Promise<void> {
  const paths = artifactSetPaths(outputPath);
  await Promise.all(paths.map((path) => rm(path, { force: true })));
  const directory = dirname(resolve(outputPath));
  try {
    const entries = await readdir(directory);
    const temporaryNames = new Set(paths.map((path) => `${path.split('/').at(-1)}.tmp-`));
    await Promise.all(
      entries
        .filter((entry) => [...temporaryNames].some((prefix) => entry.startsWith(prefix)))
        .map((entry) => rm(resolve(directory, entry), { force: true })),
    );
  } catch (cause) {
    if (!isMissingPath(cause)) {
      throw new ArtifactIoError('artifact_invalidation_failed', { cause });
    }
  }
}

export interface ComparatorPreflightFailureReceipt {
  readonly reason: string;
  readonly expected_root: '$PROJECT/.omo/comparators';
}

export async function writeBenchmarkFailureReceipt(
  outputPath: string,
  exitCode: number,
  stage: 'build' | 'bridge_start' | 'preflight',
  comparator?: ComparatorPreflightFailureReceipt,
): Promise<string> {
  await invalidateBenchmarkArtifacts(outputPath);
  const directory = dirname(resolve(outputPath));
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, `${artifactBaseName(outputPath)}.command-exit.json`);
  await atomicWrite(
    path,
    `${JSON.stringify(
      {
        schema_version: 'cursor-composer-parity-command-exit/v1',
        completed: true,
        exit_code: exitCode,
        verdict: 'infra_fail',
        stage,
        ...(comparator ? { comparator } : {}),
      },
      null,
      2,
    )}\n`,
  );
  return path;
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, contents);
  await rename(temporary, path);
}

async function remainingBenchmarkDirs(tempRoot: string): Promise<number> {
  try {
    const entries = await readdir(tempRoot);
    return entries.filter((entry) => entry.startsWith('cursor-composer-benchmark-')).length;
  } catch (cause) {
    throw new ArtifactIoError('cleanup_observation_failed', { cause });
  }
}

export async function writeBenchmarkArtifacts(
  outputPath: string,
  result: BenchmarkRunResult,
  runtime: ArtifactRuntimeReceipt,
): Promise<ArtifactPaths> {
  const jsonPath = resolve(outputPath);
  const directory = dirname(jsonPath);
  await mkdir(directory, { recursive: true });
  const markdownPath = jsonPath.endsWith('.json')
    ? `${jsonPath.slice(0, -5)}.md`
    : `${jsonPath}.md`;
  validateRetainedTraceJoins(result.evidence, runtime.traceRecords);
  const refs = result.evidence.companions.files;
  const byKind = new Map(refs.map((file) => [file.kind, resolve(directory, file.path)]));
  const companionPath = (kind: (typeof refs)[number]['kind']): string => {
    const path = byKind.get(kind);
    if (!path) throw new Error(`missing ${kind} companion path`);
    return path;
  };
  const tracePath = companionPath('bridge_trace');
  const versionsPath = companionPath('versions_environment');
  const commandPath = companionPath('command_exit');
  const cleanupPath = companionPath('cleanup');
  const generatedAt = result.evidence.suite.generated_at;
  const traceText = runtime.traceRecords.map((record) => JSON.stringify(record)).join('\n');
  const inspection = runtime.comparator?.inspection ?? null;
  const versions = {
    schema_version: 'cursor-composer-parity-companion/v1',
    generated_at: generatedAt,
    omo_version: inspection?.observedOmoVersion ?? null,
    senpi_engine_version: inspection?.observedSenpiVersion ?? null,
    observed_version_string: inspection?.observedVersionString ?? null,
    pinned_omo_version: PINNED_OMO_VERSION,
    pinned_senpi_engine_version: PINNED_SENPI_VERSION,
    comparator: runtime.comparator
      ? {
          resolved_path: runtime.comparator.executable.sanitizedPath,
          path_provenance: runtime.comparator.executable.provenance,
          resolved_path_is_absolute: true,
          model_id: 'composer-2.5',
          model_observed: inspection?.modelObserved ?? false,
        }
      : null,
    live_comparator_parity_claimed:
      inspection?.outcome === null && inspection.modelObserved === true,
    native_provider: 'cursor',
    yorha_provider: 'yorha',
    model_id: 'composer-2.5',
    active_backend: result.evidence.environment.active_backend ?? null,
    bridge_version: result.evidence.environment.bridge_version ?? null,
    node_version: process.version,
    platform: process.platform,
    account_mismatch: result.evidence.companions.account_mismatch,
    latency_confounded: result.evidence.companions.latency_confounded,
    shared_stable_identity_proven:
      result.evidence.companions.account_comparability.cryptographic_identity_proven,
    account_comparability: result.evidence.companions.account_comparability,
  };
  const command = {
    schema_version: 'cursor-composer-parity-command-exit/v1',
    generated_at: generatedAt,
    completed: true,
    exit_code: runtime.exitCode,
    verdict: result.evidence.verdict,
  };
  const cleanup = {
    schema_version: 'cursor-composer-parity-cleanup/v1',
    generated_at: generatedAt,
    bridge: runtime.bridgeCleanup,
    temporary_directories_remaining: await remainingBenchmarkDirs(runtime.tempRoot),
    benchmark_owned_resources_remaining: runtime.bridgeCleanup?.close_observed === false ? 1 : 0,
    unrelated_resources_touched: 0,
  };
  const markdown = renderMarkdownReport({
    evidence: result.evidence,
    schedule: result.schedule,
    isMeasured: isMeasuredTrialFactory(result.schedule),
  });

  await Promise.all([
    atomicWrite(tracePath, traceText ? `${traceText}\n` : ''),
    atomicWrite(versionsPath, `${JSON.stringify(versions, null, 2)}\n`),
    atomicWrite(commandPath, `${JSON.stringify(command, null, 2)}\n`),
    atomicWrite(cleanupPath, `${JSON.stringify(cleanup, null, 2)}\n`),
  ]);
  await atomicWrite(jsonPath, `${JSON.stringify(result.evidence, null, 2)}\n`);
  await atomicWrite(markdownPath, markdown);
  return {
    jsonPath,
    markdownPath,
    companionPaths: [tracePath, versionsPath, commandPath, cleanupPath],
  };
}
