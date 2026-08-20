import { unprovedAccountComparability } from './account-comparability.js';
import { sentinelFor } from './cases.js';
import { sha256Hex } from './normalize.js';
import { benchmarkCompanions, firstDivergences, overheadRows } from './evidence-contract.js';
import { BenchmarkEvidenceSchema } from './schema.js';
import {
  buildPairSchedule,
  buildTrialPrompt,
  expectedCallsFor,
  isMeasuredTrialFactory,
  type BenchmarkProfile,
  type PairScheduleEntry,
} from './schedule.js';
import {
  computeMetricStatistics,
  computePairedStatistics,
  computeResidualOverhead,
  evaluateGates,
  verdictFromGates,
  type ResidualOverhead,
} from './statistics.js';
import {
  assembleTrialRecord,
  isInfraStop,
  isQuotaStop,
  type LaneTrialRequest,
  type LaneTrialSample,
  type PreflightSnapshot,
} from './trial-record.js';
import type {
  BenchmarkCase,
  BenchmarkEvidence,
  CompanionFileReference,
  FailureClass,
  TrialRecord,
} from './types.js';

export {
  BENCHMARK_PROFILES,
  buildPairSchedule,
  buildTrialPrompt,
  expectedCallsFor,
  isMeasuredTrialFactory,
} from './schedule.js';
export { owningLayerFor } from './trial-record.js';
export type { BenchmarkProfile, PairScheduleEntry } from './schedule.js';
export type { LaneTrialRequest, LaneTrialSample, PreflightSnapshot } from './trial-record.js';

export interface RunnerDependencies {
  executeTrial: (request: LaneTrialRequest) => Promise<LaneTrialSample>;
  preflight?: () => Promise<PreflightSnapshot>;
  now?: () => Date;
}

export interface RunBenchmarkOptions {
  seed: number;
  profile: BenchmarkProfile;
  cases: readonly BenchmarkCase[];
  dryRun: boolean;
  signal?: AbortSignal;
  companionFiles?: readonly CompanionFileReference[];
}

export interface BenchmarkRunResult {
  evidence: BenchmarkEvidence;
  schedule: readonly PairScheduleEntry[];
  residuals: readonly ResidualOverhead[];
}

type StopReason = FailureClass | 'quota_stop' | null;

function environmentRecord(
  options: RunBenchmarkOptions,
  schedule: readonly PairScheduleEntry[],
  preflight: PreflightSnapshot | null,
  interrupted: boolean,
  stopReason: StopReason,
): Record<string, string | number | boolean | null> {
  const record: Record<string, string | number | boolean | null> = {
    node_version: process.version,
    platform: process.platform,
    profile: options.profile,
    dry_run: options.dryRun ? 'true' : 'false',
    scheduled_pairs: schedule.length,
    scheduled_trials: schedule.reduce((total, entry) => total + entry.lanes.length, 0),
    warmup_pairs: schedule.filter((entry) => entry.phase === 'warmup').length,
    measured_pairs: schedule.filter((entry) => entry.phase === 'measured').length,
  };
  if (preflight) {
    record.active_backend = preflight.activeBackend;
    record.bridge_version = preflight.bridgeVersion;
  }
  if (interrupted) record.interrupted = 'true';
  if (stopReason) record.stop_reason = stopReason;
  if (stopReason === 'quota_stop') record.quota_consecutive_stop = 'true';
  return record;
}

function laneRequest(
  options: RunBenchmarkOptions,
  schedule: readonly PairScheduleEntry[],
  entry: PairScheduleEntry,
  lane: 'native' | 'yorha',
): LaneTrialRequest {
  const testCase = options.cases.find((candidate) => candidate.id === entry.caseId);
  if (!testCase) throw new RangeError(`scheduled benchmark case is missing: ${entry.caseId}`);
  const sentinel = sentinelFor(entry.caseId, options.seed, entry.pairIndex, lane);
  const concurrency = testCase.kind === 'concurrency' ? 2 : 1;
  const peerSentinels =
    concurrency === 2
      ? [sentinelFor(entry.caseId, options.seed, entry.pairIndex + schedule.length, lane)]
      : [];
  const prompt = buildTrialPrompt(testCase, sentinel);
  return {
    testCase,
    pairIndex: entry.pairIndex,
    phase: entry.phase,
    lane,
    sentinel,
    peerSentinels,
    prompt,
    promptHash: sha256Hex(prompt),
    expectedCalls: expectedCallsFor(testCase, sentinel),
    omoSeed: `${options.seed}-${entry.caseId}-${entry.pairIndex}-${lane}`,
    concurrency,
    signal: options.signal ?? new AbortController().signal,
  };
}

export async function runBenchmark(
  options: RunBenchmarkOptions,
  dependencies: RunnerDependencies,
): Promise<BenchmarkRunResult> {
  const schedule = buildPairSchedule(options);
  const isMeasured = isMeasuredTrialFactory(schedule);
  const trials: TrialRecord[] = [];
  let preflight: PreflightSnapshot | null = null;
  let stopReason: StopReason = null;
  let interrupted = false;
  let consecutiveQuota = 0;

  if (!options.dryRun) {
    if (!dependencies.preflight)
      throw new Error('live benchmark runs require a preflight dependency');
    preflight = await dependencies.preflight();
    if (!preflight.ok || preflight.activeBackend !== 'cursor-api') stopReason = 'infra_fail';
    for (const entry of schedule) {
      if (stopReason !== null || options.signal?.aborted) break;
      for (const lane of entry.lanes) {
        if (stopReason !== null || options.signal?.aborted) break;
        const request = laneRequest(options, schedule, entry, lane);
        const trial = assembleTrialRecord(request, await dependencies.executeTrial(request));
        trials.push(trial);
        if (isQuotaStop(trial.failure_class)) {
          consecutiveQuota += 1;
          if (consecutiveQuota >= 3) stopReason = 'quota_stop';
        } else consecutiveQuota = 0;
        if (isInfraStop(trial.failure_class)) stopReason = trial.failure_class;
      }
    }
    if (options.signal?.aborted) {
      interrupted = true;
      stopReason ??= 'infra_fail';
    }
  }

  const filter = { trials, isMeasured };
  const laneStatistics = computeMetricStatistics(filter);
  const pairedStatistics = computePairedStatistics({
    ...filter,
    suiteSeed: options.seed,
  });
  const residuals = computeResidualOverhead({
    ...filter,
    cases: options.cases,
  });
  const gates = options.dryRun
    ? [
        {
          id: 'dry_run',
          case_id: null,
          metric: null,
          status: 'not_applicable' as const,
          observed: null,
          threshold: null,
        },
      ]
    : evaluateGates({
        ...filter,
        profile: options.profile,
        cases: options.cases,
        paired: pairedStatistics,
      });
  const override =
    stopReason === 'quota_stop' ? 'quota_stop' : stopReason !== null ? 'infra_fail' : null;
  const evidence: BenchmarkEvidence = {
    schema_version: 'cursor-composer-parity-metrics/v1',
    suite: {
      seed: options.seed,
      profile: options.profile,
      generated_at: (dependencies.now ?? (() => new Date()))().toISOString(),
    },
    environment: {
      ...environmentRecord(options, schedule, preflight, interrupted, stopReason),
      completed_trials: trials.length,
    },
    cases: options.cases.map((testCase) => testCase),
    trials,
    statistics: [...laneStatistics, ...pairedStatistics],
    overhead: overheadRows(residuals),
    first_divergences: firstDivergences(gates, trials),
    companions: benchmarkCompanions(
      options.companionFiles,
      preflight?.accountComparability ?? unprovedAccountComparability('dry_run'),
    ),
    gates,
    verdict: options.dryRun ? 'fail' : verdictFromGates(gates, override),
  };
  const parsed = BenchmarkEvidenceSchema.safeParse(evidence);
  if (!parsed.success)
    throw new Error(`benchmark evidence failed its own schema: ${parsed.error.message}`);
  return { evidence, schedule, residuals };
}
