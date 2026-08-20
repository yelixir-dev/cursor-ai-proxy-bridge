import { describe, expect, it, vi } from 'vitest';
import { unprovedAccountComparability } from '../src/benchmark/account-comparability.js';
import { createCanonicalCases, sentinelFor } from '../src/benchmark/cases.js';
import { BenchmarkEvidenceSchema } from '../src/benchmark/schema.js';
import { owningLayerFor } from '../src/benchmark/trial-record.js';
import { FAILURE_CLASSES } from '../src/benchmark/types.js';
import {
  BENCHMARK_PROFILES,
  buildPairSchedule,
  buildTrialPrompt,
  expectedCallsFor,
  runBenchmark,
  type LaneTrialRequest,
  type LaneTrialSample,
  type RunnerDependencies,
} from '../src/benchmark/runner.js';
import { CliUsageError, parseBenchmarkArgs } from '../src/benchmark/cli.js';
import type { BenchmarkCase, CanonicalCaseId, FailureClass } from '../src/benchmark/types.js';
import { requireValue } from './support/strict-accessors.js';

const SEED = 20260818;
const CASES = createCanonicalCases();

function selectCases(ids: readonly CanonicalCaseId[]): BenchmarkCase[] {
  return CASES.filter((candidate) => ids.includes(candidate.id));
}

function passingTextEvents(sentinel: string): unknown[] {
  return [
    { type: 'agent_start', atMs: 0 },
    { type: 'text_delta', delta: `ack ${sentinel}`, atMs: 5 },
    { type: 'agent_end', atMs: 6 },
  ];
}

interface ExecutorPlan {
  failureClass?: FailureClass;
  promptHash?: string;
  onCall?: (request: LaneTrialRequest, call: number) => void;
}

interface Harness {
  calls: LaneTrialRequest[];
  dependencies: RunnerDependencies;
}

const emptyTrialChild = () => ({ diagnostics: '', exits: [], session: null });

function traceJoinFor(request: LaneTrialRequest, upstreamRuns: number) {
  if (request.lane === 'native') return null;
  if (request.testCase.kind === 'malformed' && upstreamRuns === 0) {
    return {
      sequence_start: null,
      sequence_end: null,
      request_ids: [],
      record_count: 0,
      attributed_run_count: 0,
      synchronized: true,
    };
  }
  const caseIndex = CASES.findIndex((candidate) => candidate.id === request.testCase.id);
  const start = (caseIndex * 100 + request.pairIndex) * 10 + 1;
  return {
    sequence_start: start,
    sequence_end: start + 1,
    request_ids: [`req-${caseIndex}-${request.pairIndex}-${request.lane}`],
    record_count: 2,
    attributed_run_count: upstreamRuns,
    synchronized: true,
  };
}

function makeHarness(plan: ExecutorPlan = {}): Harness {
  const calls: LaneTrialRequest[] = [];
  let inFlight = false;
  const dependencies: RunnerDependencies = {
    async preflight() {
      return {
        ok: true,
        activeBackend: 'cursor-api',
        bridgeVersion: '0.1.0',
        accountComparability: unprovedAccountComparability('bridge_credential_missing'),
      };
    },
    now: () => new Date('2026-08-18T00:00:00.000Z'),
    async executeTrial(request) {
      expect(inFlight, 'runner must keep one paid completion in flight').toBe(false);
      inFlight = true;
      try {
        const call = calls.length + 1;
        plan.onCall?.(request, call);
        calls.push(request);
        const sample: LaneTrialSample = {
          rawEvents: passingTextEvents(request.sentinel),
          durationMs: 10 + call,
          upstreamRuns: 1,
          failureClass: plan.failureClass ?? null,
          promptHash: plan.promptHash ?? null,
          httpStatus: null,
          isolatedSentinels: null,
          traceJoin: traceJoinFor(request, 1),
          childReport: emptyTrialChild(),
        };
        return sample;
      } finally {
        inFlight = false;
      }
    },
  };
  return { calls, dependencies };
}

function runOptions(ids: readonly CanonicalCaseId[], dryRun = false) {
  return {
    seed: SEED,
    profile: 'smoke' as const,
    cases: selectCases(ids),
    dryRun,
  };
}

describe('pair schedule construction', () => {
  it('is a deterministic Fisher-Yates case permutation with alternating lane order', () => {
    const options = { seed: SEED, profile: 'smoke' as const, cases: CASES };
    const first = buildPairSchedule(options);
    const second = buildPairSchedule(options);
    expect(first).toEqual(second);

    const order = [...new Set(first.map((entry) => entry.caseId))];
    expect(order.length).toBe(CASES.length);
    expect(new Set(order).size).toBe(CASES.length);
    const otherSeed = buildPairSchedule({ ...options, seed: SEED + 1 });
    expect([...new Set(otherSeed.map((entry) => entry.caseId))]).not.toEqual(order);

    const entry = requireValue(
      first.find((candidate) => candidate.caseId === 'text_sentinel_stream'),
      'schedule entry for text_sentinel_stream',
    );
    expect(entry.lanes).toHaveLength(2);
    expect(first[0].lanes.length).toBeGreaterThanOrEqual(1);
    for (const group of [first, second]) {
      const byCase = new Map<string, typeof group>();
      for (const item of group) {
        const list = byCase.get(item.caseId) ?? [];
        list.push(item);
        byCase.set(item.caseId, list);
      }
      for (const list of byCase.values()) {
        expect(list[0]?.phase).toBe('warmup');
        expect(list.filter((item) => item.phase === 'warmup').length).toBe(1);
        const twoLane = list[0].lanes.length === 2;
        list.forEach((item, index) => {
          expect(item.pairIndex).toBe(index);
          if (twoLane) {
            expect(item.lanes).toEqual(index % 2 === 0 ? ['native', 'yorha'] : ['yorha', 'native']);
          } else {
            expect(item.lanes).toEqual(['yorha']);
          }
        });
      }
    }
  });

  it('honors profile pair counts and schedules malformed cases on the yorha lane only', () => {
    expect(BENCHMARK_PROFILES).toEqual({
      smoke: { warmupPairs: 1, samplePairs: 3 },
      ci: { warmupPairs: 1, samplePairs: 11 },
      strict: { warmupPairs: 2, samplePairs: 21 },
    });
    const smoke = buildPairSchedule({
      seed: SEED,
      profile: 'smoke',
      cases: CASES,
    });
    const strict = buildPairSchedule({
      seed: SEED,
      profile: 'strict',
      cases: CASES,
    });
    expect(smoke.length).toBe(CASES.length * 4);
    expect(strict.length).toBe(CASES.length * 23);
    const malformed = smoke.filter((entry) => entry.caseId.startsWith('malformed_'));
    expect(malformed.length).toBe(6 * 4);
    for (const entry of malformed) expect(entry.lanes).toEqual(['yorha']);
    const regular = requireValue(
      smoke.find((entry) => entry.caseId === 'text_sentinel_stream'),
      'smoke schedule entry for text_sentinel_stream',
    );
    expect(regular.lanes).toEqual(['native', 'yorha']);
  });

  it('uses lane-paired sentinels and canonical prompts with expected calls', () => {
    const testCase = selectCases(['tool_parallel_two'])[0];
    const sentinel = sentinelFor('tool_parallel_two', SEED, 0, 'native');
    const prompt = buildTrialPrompt(testCase, sentinel);
    expect(prompt).toContain(sentinel);
    expect(prompt).not.toContain('\n');
    expect(expectedCallsFor(testCase, sentinel)).toEqual([
      { name: 'echo_value', arguments: { value: sentinel } },
      { name: 'echo_value', arguments: { value: `${sentinel}_SECOND` } },
    ]);
    const textCase = selectCases(['text_sentinel_stream'])[0];
    expect(expectedCallsFor(textCase, sentinel)).toEqual([]);
    expect(buildTrialPrompt(textCase, sentinel)).toContain(sentinel);
    const sequential = selectCases(['tool_sequential_two_round'])[0];
    expect(expectedCallsFor(sequential, sentinel)).toEqual([
      { name: 'lookup_code', arguments: { key: 'ALPHA' } },
    ]);
  });
});

describe('benchmark runner', () => {
  it('emits schema-valid dry-run evidence with the exact schedule and no execution', async () => {
    const harness = makeHarness({
      onCall: () => {
        throw new Error('dry-run must not execute trials');
      },
    });
    const preflight = vi.fn(harness.dependencies.preflight);
    const result = await runBenchmark(runOptions(['text_sentinel_stream'], true), {
      ...harness.dependencies,
      preflight,
    });
    expect(preflight).not.toHaveBeenCalled();
    expect(harness.calls).toHaveLength(0);
    expect(result.schedule.length).toBe(4);
    expect(result.evidence.trials).toEqual([]);
    expect(result.evidence.environment.dry_run).toBe('true');
    expect(result.evidence.verdict).toBe('fail');
    expect(result.evidence.gates.map((gate) => gate.id)).toContain('dry_run');
    expect(() => BenchmarkEvidenceSchema.parse(result.evidence)).not.toThrow();
  });

  it('runs paired trials sequentially and produces a passing verdict deterministically', async () => {
    const first = await runBenchmark(
      runOptions(['text_sentinel_stream']),
      makeHarness().dependencies,
    );
    expect(first.evidence.trials).toHaveLength(8);
    expect(first.evidence.verdict).toBe('pass');
    expect(() => BenchmarkEvidenceSchema.parse(first.evidence)).not.toThrow();

    const second = await runBenchmark(
      runOptions(['text_sentinel_stream']),
      makeHarness().dependencies,
    );
    expect(JSON.stringify(second.evidence)).toBe(JSON.stringify(first.evidence));

    const laneStats = first.evidence.statistics.filter((entry) => 'sample_count' in entry);
    expect(laneStats.length).toBeGreaterThan(0);
  });

  it('retains correctness failures without retry or latency inclusion', async () => {
    const harness = makeHarness({
      onCall: (_request, call) => {
        if (call === 3) throw new Error('should not be called again');
      },
    });
    let call = 0;
    const failingText = (): unknown[] => [
      { type: 'agent_start', atMs: 0 },
      { type: 'text_delta', delta: 'wrong token entirely', atMs: 5 },
      { type: 'agent_end', atMs: 6 },
    ];
    const dependencies: RunnerDependencies = {
      ...harness.dependencies,
      async executeTrial(request) {
        call += 1;
        if (call === 4) {
          return {
            rawEvents: failingText(),
            durationMs: 12,
            upstreamRuns: 1,
            failureClass: null,
            promptHash: null,
            httpStatus: null,
            isolatedSentinels: null,
            traceJoin: traceJoinFor(request, 1),
            childReport: emptyTrialChild(),
          };
        }
        return {
          rawEvents: passingTextEvents(request.sentinel),
          durationMs: 10 + call,
          upstreamRuns: 1,
          failureClass: null,
          promptHash: null,
          httpStatus: null,
          isolatedSentinels: null,
          traceJoin: traceJoinFor(request, 1),
          childReport: emptyTrialChild(),
        };
      },
    };
    const result = await runBenchmark(runOptions(['text_sentinel_stream']), dependencies);
    expect(call).toBe(8);
    const failed = result.evidence.trials.find((trial) => !trial.passed);
    expect(failed?.failure_class).toBe('sentinel_mismatch');
    expect(failed?.metrics.turn_wall_ms).toBe(5);
    expect(failed?.pair_index).toBe(1);
    expect(result.evidence.verdict).toBe('fail');
    expect(result.evidence.first_divergences).toEqual([
      {
        gate_id: 'correctness.text_sentinel_stream',
        case_id: 'text_sentinel_stream',
        metric: null,
        failure_class: 'sentinel_mismatch',
        owning_layer: 'model_variance',
      },
    ]);
    const turnWall = result.evidence.statistics.find(
      (entry) =>
        'sample_count' in entry && entry.metric === 'turn_wall_ms' && entry.lane === 'native',
    );
    expect(turnWall && 'sample_count' in turnWall ? turnWall.sample_count : 0).toBe(2);
  });

  it('records harness failure samples without fabricating model events', async () => {
    const dependencies = makeHarness({ failureClass: 'quota' }).dependencies;
    const result = await runBenchmark(runOptions(['text_sentinel_stream']), dependencies);
    const trial = result.evidence.trials[0];
    expect(trial.passed).toBe(false);
    expect(trial.failure_class).toBe('quota');
    expect(trial.events.length).toBeGreaterThan(0);
    expect(
      trial.events.every((event) => event.type !== 'error' || event.failureClass === 'quota'),
    ).toBe(true);
    expect(() => BenchmarkEvidenceSchema.parse(result.evidence)).not.toThrow();
  });

  it('stops after three consecutive quota or rate failures as quota_stop', async () => {
    const harness = makeHarness({ failureClass: 'quota' });
    const result = await runBenchmark(runOptions(['text_sentinel_stream']), harness.dependencies);
    expect(harness.calls).toHaveLength(3);
    expect(result.evidence.verdict).toBe('quota_stop');
    expect(result.evidence.environment.quota_consecutive_stop).toBe('true');
  });

  it('stops before any trial when preflight does not report the cursor-api backend', async () => {
    const harness = makeHarness();
    const dependencies: RunnerDependencies = {
      ...harness.dependencies,
      preflight: async () => ({
        ok: true,
        activeBackend: 'auto',
        bridgeVersion: '0.1.0',
        accountComparability: unprovedAccountComparability('bridge_credential_missing'),
      }),
    };
    const result = await runBenchmark(runOptions(['text_sentinel_stream']), dependencies);
    expect(harness.calls).toHaveLength(0);
    expect(result.evidence.verdict).toBe('infra_fail');
    expect(result.evidence.environment.active_backend).toBe('auto');
    expect(result.evidence.environment.completed_trials).toBe(0);
  });

  it('stops before the next trial when a lane prompt hash drifts', async () => {
    const harness = makeHarness({ promptHash: 'a'.repeat(64) });
    const result = await runBenchmark(runOptions(['text_sentinel_stream']), harness.dependencies);
    expect(harness.calls).toHaveLength(1);
    expect(result.evidence.trials).toHaveLength(1);
    expect(result.evidence.trials[0].failure_class).toBe('prompt_mismatch');
    expect(result.evidence.trials[0].owning_layer).toBe('harness');
    expect(result.evidence.verdict).toBe('infra_fail');
    expect(result.evidence.environment.stop_reason).toBe('prompt_mismatch');
    expect(() => BenchmarkEvidenceSchema.parse(result.evidence)).not.toThrow();
  });

  it('stops before the next trial when the comparator version mismatches', async () => {
    const harness = makeHarness({ failureClass: 'harness_version_mismatch' });
    const result = await runBenchmark(runOptions(['text_sentinel_stream']), harness.dependencies);
    expect(harness.calls).toHaveLength(1);
    expect(result.evidence.trials[0].failure_class).toBe('harness_version_mismatch');
    expect(result.evidence.verdict).toBe('infra_fail');
    expect(result.evidence.environment.stop_reason).toBe('harness_version_mismatch');
    expect(result.evidence.environment.completed_trials).toBe(1);
  });

  it('maps every failure class to exactly one owning layer', () => {
    for (const failureClass of FAILURE_CLASSES) {
      expect(typeof owningLayerFor(failureClass)).toBe('string');
    }
  });

  it('treats a backend flip as an immediate infra failure', async () => {
    const harness = makeHarness({ failureClass: 'backend_flip' });
    const result = await runBenchmark(runOptions(['text_sentinel_stream']), harness.dependencies);
    expect(harness.calls).toHaveLength(1);
    expect(result.evidence.verdict).toBe('infra_fail');
  });

  it('stops scheduling when the run signal aborts and keeps completed trials', async () => {
    const controller = new AbortController();
    const harness = makeHarness({
      onCall: () => {
        controller.abort();
      },
    });
    const result = await runBenchmark(
      { ...runOptions(['text_sentinel_stream']), signal: controller.signal },
      harness.dependencies,
    );
    expect(harness.calls).toHaveLength(1);
    expect(result.evidence.trials).toHaveLength(1);
    expect(result.evidence.verdict).toBe('infra_fail');
    expect(result.evidence.environment.interrupted).toBe('true');
    expect(result.evidence.environment.completed_trials).toBe(1);
  });

  it('runs the concurrency case as one in-flight exception with peer sentinels', async () => {
    const harness = makeHarness();
    const result = await runBenchmark(runOptions(['client_parallel_two']), harness.dependencies);
    expect(harness.calls).toHaveLength(8);
    for (const request of harness.calls) {
      expect(request.concurrency).toBe(2);
      expect(request.peerSentinels).toHaveLength(1);
      expect(request.peerSentinels[0]).not.toBe(request.sentinel);
    }
    expect(() => BenchmarkEvidenceSchema.parse(result.evidence)).not.toThrow();
  });
});

describe('authoritative malformed-input verdicts', () => {
  const rejectionEvents = (): unknown[] => [
    { type: 'agent_start', atMs: 0 },
    { type: 'agent_end', atMs: 2 },
  ];

  function harnessReturning(sample: LaneTrialSample): RunnerDependencies {
    return {
      ...makeHarness().dependencies,
      async executeTrial(request) {
        if (!sample.traceJoin || sample.traceJoin.record_count === 0) return sample;
        const start = request.pairIndex * 10 + 1;
        return {
          ...sample,
          traceJoin: {
            ...sample.traceJoin,
            sequence_start: start,
            sequence_end: start + sample.traceJoin.record_count - 1,
            request_ids: [`req-malformed-${request.pairIndex}`],
          },
        };
      },
    };
  }

  function httpSample(httpStatus: number | null, upstreamRuns: number): LaneTrialSample {
    return {
      rawEvents: rejectionEvents(),
      durationMs: 2,
      upstreamRuns,
      failureClass: null,
      promptHash: null,
      httpStatus,
      isolatedSentinels: null,
      traceJoin:
        upstreamRuns === 0
          ? {
              sequence_start: null,
              sequence_end: null,
              request_ids: [],
              record_count: 0,
              attributed_run_count: 0,
              synchronized: true,
            }
          : {
              sequence_start: 1,
              sequence_end: upstreamRuns,
              request_ids: ['req-malformed'],
              record_count: upstreamRuns,
              attributed_run_count: upstreamRuns,
              synchronized: true,
            },
      childReport: emptyTrialChild(),
    };
  }

  it('fails a malformed case whose rejection reached an upstream Run', async () => {
    const result = await runBenchmark(
      runOptions(['malformed_json']),
      harnessReturning(httpSample(400, 4)),
    );
    expect(
      result.evidence.trials.every((trial) => trial.failure_class === 'invalid_request_accepted'),
    ).toBe(true);
    expect(result.evidence.verdict).toBe('fail');
  });

  it('fails a malformed case that was not rejected with HTTP 400', async () => {
    const result = await runBenchmark(
      runOptions(['malformed_json']),
      harnessReturning(httpSample(200, 0)),
    );
    expect(
      result.evidence.trials.every((trial) => trial.failure_class === 'invalid_request_accepted'),
    ).toBe(true);
  });

  it('passes a malformed case only with HTTP 400 and zero upstream runs', async () => {
    const result = await runBenchmark(
      runOptions(['malformed_json']),
      harnessReturning(httpSample(400, 0)),
    );
    expect(result.evidence.verdict).toBe('pass');
    expect(() => BenchmarkEvidenceSchema.parse(result.evidence)).not.toThrow();
  });
});

describe('authoritative concurrency verdicts', () => {
  const eventsFor = (sentinels: readonly string[]): unknown[] =>
    sentinels.flatMap((sentinel) => [
      { type: 'agent_start', atMs: 0 },
      { type: 'text_delta', atMs: 3, delta: `ok ${sentinel}` },
      { type: 'agent_end', atMs: 4 },
    ]);

  function harnessWith(
    events: (request: LaneTrialRequest) => unknown[],
    receipts: (request: LaneTrialRequest) => readonly string[],
  ): RunnerDependencies {
    return {
      ...makeHarness().dependencies,
      async executeTrial(request) {
        return {
          rawEvents: events(request),
          durationMs: 5,
          upstreamRuns: 1,
          failureClass: null,
          promptHash: null,
          httpStatus: null,
          isolatedSentinels: receipts(request),
          traceJoin: traceJoinFor(request, 1),
          childReport: emptyTrialChild(),
        };
      },
    };
  }

  it('fails when only one isolated sentinel receipt exists even if merged text contains both', async () => {
    const result = await runBenchmark(
      runOptions(['client_parallel_two']),
      harnessWith(
        (request) => eventsFor([request.sentinel, ...request.peerSentinels]),
        (request) => [request.sentinel],
      ),
    );
    expect(
      result.evidence.trials.every((trial) => trial.failure_class === 'sentinel_mismatch'),
    ).toBe(true);
    expect(result.evidence.verdict).toBe('fail');
  });

  it('passes when both isolated sentinels are observed', async () => {
    const result = await runBenchmark(
      runOptions(['client_parallel_two']),
      harnessWith(
        (request) => eventsFor([request.sentinel, ...request.peerSentinels]),
        (request) => [request.sentinel, ...request.peerSentinels],
      ),
    );
    expect(result.evidence.verdict).toBe('pass');
    expect(() => BenchmarkEvidenceSchema.parse(result.evidence)).not.toThrow();
  });
});

describe('benchmark CLI argument parsing', () => {
  it('parses the full surface with defaults', () => {
    expect(
      parseBenchmarkArgs([
        '--profile',
        'ci',
        '--seed',
        '7',
        '--case',
        'tool_auto_single',
        '--case',
        'text_sentinel_stream',
        '--output',
        'out.json',
        '--dry-run',
      ]),
    ).toEqual({
      profile: 'ci',
      seed: 7,
      caseIds: ['tool_auto_single', 'text_sentinel_stream'],
      output: 'out.json',
      dryRun: true,
    });
    expect(parseBenchmarkArgs([])).toEqual({
      profile: 'smoke',
      seed: SEED,
      caseIds: null,
      output: '.omo/evidence/cursor-composer-parity-benchmark/composer-parity.json',
      dryRun: false,
    });
  });

  it.each([
    ['unknown flag', ['--verbose']],
    ['missing value', ['--profile']],
    ['bad profile', ['--profile', 'ultra']],
    ['bad case id', ['--case', 'not_a_case']],
    ['duplicate case', ['--case', 'tool_auto_single', '--case', 'tool_auto_single']],
    ['negative seed', ['--seed', '-1']],
    ['non-numeric seed', ['--seed', 'abc']],
    ['positional argument', ['extra.json']],
  ])('rejects %s', (_name, argv) => {
    expect(() => parseBenchmarkArgs(argv)).toThrow(CliUsageError);
  });
});
