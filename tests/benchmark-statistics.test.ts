import { describe, expect, it } from 'vitest';
import { createCanonicalCases, requestHashForCase, sentinelFor } from '../src/benchmark/cases.js';
import {
  BOOTSTRAP_RESAMPLES,
  LATENCY_GATE_METRICS,
  PAIRED_RATIO_CI_UPPER_MAX,
  PAIRED_RATIO_MEDIAN_MAX,
  bootstrapMedianCi,
  computeMetricStatistics,
  computePairedStatistics,
  computeResidualOverhead,
  countCorrectness,
  createDeterministicRandom,
  evaluateGates,
  hashSeed,
  medianUpstreamRuns,
  overheadRows,
  quantile,
  summarize,
  verdictFromGates,
} from '../src/benchmark/statistics.js';
import {
  METRIC_NAMES,
  type BenchmarkCase,
  type BenchmarkGate,
  type CanonicalCaseId,
  type MetricName,
  type PairedStatistic,
  type TrialMetrics,
  type TrialRecord,
} from '../src/benchmark/types.js';

const SEED = 20260818;
const CASES = createCanonicalCases();

function caseById(id: CanonicalCaseId): BenchmarkCase {
  const found = CASES.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`missing canonical case ${id}`);
  return found;
}

interface TrialOptions {
  passed?: boolean;
  values?: Partial<Record<MetricName, number>>;
  measured?: boolean;
  upstreamRuns?: number;
}

function metricsWith(
  testCase: BenchmarkCase,
  values: Partial<Record<MetricName, number>>,
): TrialMetrics {
  return Object.fromEntries(
    METRIC_NAMES.map((name) => [
      name,
      testCase.nullMetrics.includes(name) ? null : (values[name] ?? 10),
    ]),
  ) as TrialMetrics;
}

function makeTrial(
  caseId: CanonicalCaseId,
  pairIndex: number,
  lane: 'native' | 'yorha',
  options: TrialOptions = {},
): TrialRecord {
  const testCase = caseById(caseId);
  const passed = options.passed ?? true;
  return {
    case_id: caseId,
    pair_index: pairIndex,
    lane,
    sentinel: sentinelFor(caseId, SEED, pairIndex, lane),
    prompt_hash: requestHashForCase(testCase),
    injection_manifest: testCase.injectionManifest,
    stream_mode: testCase.streamModes[lane],
    events: [
      { type: 'accepted', atMs: 0 },
      { type: 'terminal', atMs: 1, reason: passed ? 'completed' : 'error' },
    ],
    trace_join:
      lane === 'yorha'
        ? {
            sequence_start: pairIndex * 10 + 1,
            sequence_end: pairIndex * 10 + 2,
            request_ids: [`req-stats-${caseId}-${pairIndex}`],
            record_count: 2,
            attributed_run_count: options.upstreamRuns ?? 1,
            synchronized: true,
          }
        : null,
    child_report: { diagnostics: '', exits: [], session: null },
    canonical_tool_calls: [],
    metrics: metricsWith(testCase, options.values ?? {}),
    passed,
    failure_class: passed ? null : 'sentinel_mismatch',
    owning_layer: passed ? null : 'model_variance',
    upstream_runs: options.upstreamRuns ?? 1,
  };
}

const measuredFromPairOne = (trial: TrialRecord): boolean => trial.pair_index >= 1;

describe('deterministic summary primitives', () => {
  it('computes interpolated quantiles without mutating input order', () => {
    const values = [5, 1, 3, 2, 4];
    expect(quantile(values, 0.5)).toBe(3);
    expect(quantile(values, 0)).toBe(1);
    expect(quantile(values, 1)).toBe(5);
    expect(quantile([1, 2, 3, 4], 0.1)).toBeCloseTo(1.3, 10);
    expect(values).toEqual([5, 1, 3, 2, 4]);
    expect(quantile([], 0.5)).toBe(0);
    expect(quantile([7], 0.9)).toBe(7);
  });

  it('summarizes median, p10, p90, and iqr', () => {
    const summary = summarize([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    expect(summary.median).toBe(55);
    expect(summary.p10).toBeCloseTo(19, 10);
    expect(summary.p90).toBeCloseTo(91, 10);
    expect(summary.iqr).toBeCloseTo(summary.p90 - summary.p10, 10);
  });

  it('produces identical pseudo-random streams for identical seeds only', () => {
    const first = createDeterministicRandom(42);
    const second = createDeterministicRandom(42);
    const other = createDeterministicRandom(43);
    const sequence = Array.from({ length: 5 }, () => first());
    expect(sequence).toEqual(Array.from({ length: 5 }, () => second()));
    expect(sequence).not.toEqual(Array.from({ length: 5 }, () => other()));
    for (const value of sequence) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('hashes seed parts stably and distinctly', () => {
    expect(hashSeed([SEED, 'tool_auto_single', 'turn_wall_ms'])).toBe(
      hashSeed([SEED, 'tool_auto_single', 'turn_wall_ms']),
    );
    expect(hashSeed([SEED, 'tool_auto_single', 'turn_wall_ms'])).not.toBe(
      hashSeed([SEED, 'tool_auto_single', 'first_semantic_ms']),
    );
  });

  it('bootstraps a deterministic 95% median confidence interval', () => {
    expect(BOOTSTRAP_RESAMPLES).toBe(10_000);
    const values = [1, 1, 1, 1, 100];
    const once = bootstrapMedianCi(values, 7);
    const twice = bootstrapMedianCi(values, 7);
    expect(once).toEqual(twice);
    expect(once.lower).toBeLessThanOrEqual(once.upper);
    const spread = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const interval = bootstrapMedianCi(spread, 7);
    expect(interval.lower).toBeLessThanOrEqual(quantile(spread, 0.5));
    expect(interval.upper).toBeGreaterThanOrEqual(quantile(spread, 0.5));
    expect(bootstrapMedianCi(spread, 7)).toEqual(interval);
    expect(bootstrapMedianCi([2, 2, 2], 7)).toEqual({ lower: 2, upper: 2 });
  });
});

describe('lane and paired statistics', () => {
  it('aggregates per-lane samples and excludes warmup, failed, and null metrics', () => {
    const trials = [
      makeTrial('text_sentinel_stream', 0, 'native', {
        values: { turn_wall_ms: 100 },
      }),
      makeTrial('text_sentinel_stream', 1, 'native', {
        values: { turn_wall_ms: 110 },
      }),
      makeTrial('text_sentinel_stream', 1, 'yorha', {
        values: { turn_wall_ms: 220 },
      }),
      makeTrial('text_sentinel_stream', 2, 'native', {
        values: { turn_wall_ms: 120 },
      }),
      makeTrial('text_sentinel_stream', 2, 'yorha', {
        passed: false,
        values: { turn_wall_ms: 9_999 },
      }),
    ];
    const stats = computeMetricStatistics({
      trials,
      isMeasured: measuredFromPairOne,
    });
    const native = stats.find(
      (entry) =>
        entry.case_id === 'text_sentinel_stream' &&
        entry.metric === 'turn_wall_ms' &&
        entry.lane === 'native',
    );
    const yorha = stats.find(
      (entry) =>
        entry.case_id === 'text_sentinel_stream' &&
        entry.metric === 'turn_wall_ms' &&
        entry.lane === 'yorha',
    );
    expect(native?.sample_count).toBe(2);
    expect(native?.median).toBe(115);
    expect(yorha?.sample_count).toBe(1);
    expect(yorha?.median).toBe(220);
    expect(stats.every((entry) => entry.sample_count > 0)).toBe(true);
  });

  it('pairs lanes by case and pair index and computes deterministic ratio intervals', () => {
    const trials = [
      makeTrial('text_sentinel_stream', 1, 'native', {
        values: { turn_wall_ms: 100 },
      }),
      makeTrial('text_sentinel_stream', 1, 'yorha', {
        values: { turn_wall_ms: 150 },
      }),
      makeTrial('text_sentinel_stream', 2, 'native', {
        values: { turn_wall_ms: 200 },
      }),
      makeTrial('text_sentinel_stream', 2, 'yorha', {
        values: { turn_wall_ms: 200 },
      }),
      makeTrial('text_sentinel_stream', 3, 'native', {
        values: { turn_wall_ms: 400 },
      }),
    ];
    const input = { trials, isMeasured: measuredFromPairOne, suiteSeed: SEED };
    const once = computePairedStatistics(input);
    const twice = computePairedStatistics(input);
    expect(once).toEqual(twice);
    const turnWall = once.find(
      (entry) => entry.case_id === 'text_sentinel_stream' && entry.metric === 'turn_wall_ms',
    );
    expect(turnWall?.valid_pairs).toBe(2);
    expect(turnWall?.median_ratio).toBeCloseTo(1.25, 10);
    expect(turnWall?.ci95.lower).toBeLessThanOrEqual(turnWall?.ci95.upper ?? 0);
  });
});

describe('residual multi-turn overhead', () => {
  it('subtracts the matching yorha single-turn p90 envelope from the raw gap', () => {
    const trials = [
      makeTrial('tool_auto_single', 1, 'yorha', {
        values: { turn_wall_ms: 100 },
      }),
      makeTrial('tool_auto_single', 2, 'yorha', {
        values: { turn_wall_ms: 200 },
      }),
      makeTrial('tool_sequential_two_round', 1, 'native', {
        values: { turn_wall_ms: 200 },
      }),
      makeTrial('tool_sequential_two_round', 1, 'yorha', {
        values: { turn_wall_ms: 500 },
      }),
    ];
    const residuals = computeResidualOverhead({
      trials,
      cases: CASES,
      isMeasured: measuredFromPairOne,
    });
    const sequential = residuals.find((entry) => entry.case_id === 'tool_sequential_two_round');
    expect(sequential?.turns).toBe(2);
    expect(sequential?.raw_gap_ms).toBe(300);
    expect(sequential?.surface_envelope_ms).toBeCloseTo(190, 10);
    expect(sequential?.residual_ms).toBeCloseTo(110, 10);
    expect(residuals.every((entry) => entry.turns > 1)).toBe(true);
    expect(overheadRows(residuals)).toEqual([
      {
        case_id: 'tool_sequential_two_round',
        turns: 2,
        raw_total_gap_ms: 300,
        expected_openai_surface_cost_ms: 190,
        residual_bridge_overhead_ms: 110,
      },
    ]);
  });
});

describe('correctness counts and upstream runs', () => {
  it('counts measured outcomes separately from warmup exclusions', () => {
    const trials = [
      makeTrial('text_sentinel_stream', 0, 'native'),
      makeTrial('text_sentinel_stream', 1, 'native'),
      makeTrial('text_sentinel_stream', 1, 'yorha', { passed: false }),
      makeTrial('text_sentinel_stream', 2, 'native', { upstreamRuns: 3 }),
    ];
    const counts = countCorrectness({
      trials,
      isMeasured: measuredFromPairOne,
    });
    const entry = counts.find((item) => item.case_id === 'text_sentinel_stream');
    expect(entry).toEqual({
      case_id: 'text_sentinel_stream',
      passed: 2,
      failed: 1,
      warmup_excluded: 1,
    });
    const runs = medianUpstreamRuns({
      trials,
      isMeasured: measuredFromPairOne,
    });
    expect(runs).toEqual([
      {
        case_id: 'text_sentinel_stream',
        lane: 'native',
        median_upstream_runs: 2,
      },
      {
        case_id: 'text_sentinel_stream',
        lane: 'yorha',
        median_upstream_runs: 1,
      },
    ]);
  });
});

describe('gate evaluation', () => {
  const paired = (ratio: number, upper: number): PairedStatistic => ({
    case_id: 'text_sentinel_stream',
    metric: 'turn_wall_ms',
    valid_pairs: 3,
    median_ratio: ratio,
    ci95: { lower: ratio * 0.9, upper },
  });

  it('locks the single-turn ratio thresholds and gate metrics', () => {
    expect(PAIRED_RATIO_MEDIAN_MAX).toBe(1.35);
    expect(PAIRED_RATIO_CI_UPPER_MAX).toBe(1.75);
    expect(LATENCY_GATE_METRICS).toEqual([
      'first_semantic_ms',
      'tool_decision_ms',
      'first_complete_call_ms',
      'turn_wall_ms',
    ]);
  });

  it('evaluates correctness gates only for the smoke profile', () => {
    const trials = [makeTrial('text_sentinel_stream', 1, 'native', { passed: false })];
    const gates = evaluateGates({
      profile: 'smoke',
      cases: [caseById('text_sentinel_stream')],
      trials,
      paired: [paired(2, 3)],
      isMeasured: measuredFromPairOne,
    });
    expect(gates.map((gate) => gate.id)).toEqual(['correctness.text_sentinel_stream']);
    expect(gates[0]?.status).toBe('fail');
  });

  it('evaluates latency gates for ci and strict profiles', () => {
    const pass = evaluateGates({
      profile: 'ci',
      cases: [caseById('text_sentinel_stream')],
      trials: [makeTrial('text_sentinel_stream', 1, 'native')],
      paired: [paired(1.1, 1.2)],
      isMeasured: measuredFromPairOne,
    });
    expect(
      pass.find((gate) => gate.id === 'latency.text_sentinel_stream.turn_wall_ms')?.status,
    ).toBe('pass');
    expect(
      pass.find((gate) => gate.id === 'latency_ci.text_sentinel_stream.turn_wall_ms')?.status,
    ).toBe('pass');

    const fail = evaluateGates({
      profile: 'strict',
      cases: [caseById('text_sentinel_stream')],
      trials: [makeTrial('text_sentinel_stream', 1, 'native')],
      paired: [paired(1.5, 2.5)],
      isMeasured: measuredFromPairOne,
    });
    expect(
      fail.find((gate) => gate.id === 'latency.text_sentinel_stream.turn_wall_ms')?.status,
    ).toBe('fail');
    expect(
      fail.find((gate) => gate.id === 'latency_ci.text_sentinel_stream.turn_wall_ms')?.status,
    ).toBe('fail');
  });

  it('emits schema-safe lowercase gate ids for mixed-case case ids', () => {
    const gates = evaluateGates({
      profile: 'smoke',
      cases: [caseById('toolChoice_none'), caseById('toolChoice_forced')],
      trials: [makeTrial('toolChoice_none', 1, 'native')],
      paired: [],
      isMeasured: measuredFromPairOne,
    });
    expect(gates.map((gate) => gate.id)).toEqual([
      'correctness.toolchoice_none_prompt_only',
      'correctness.toolchoice_forced',
    ]);
    for (const gate of gates) expect(gate.id).toMatch(/^[a-z0-9_.-]+$/);
  });

  it('marks gates without measured pairs as not applicable', () => {
    const gates = evaluateGates({
      profile: 'ci',
      cases: [caseById('text_sentinel_stream')],
      trials: [],
      paired: [{ ...paired(1, 1), valid_pairs: 0 }],
      isMeasured: measuredFromPairOne,
    });
    for (const gate of gates) expect(gate.status).toBe('not_applicable');
  });

  it('derives the verdict from gates with override precedence', () => {
    const passing: BenchmarkGate[] = [
      {
        id: 'correctness.a',
        case_id: null,
        metric: null,
        status: 'pass',
        observed: 1,
        threshold: 1,
      },
    ];
    const failing: BenchmarkGate[] = [
      {
        id: 'correctness.a',
        case_id: null,
        metric: null,
        status: 'fail',
        observed: 0,
        threshold: 1,
      },
    ];
    expect(verdictFromGates(passing)).toBe('pass');
    expect(verdictFromGates(failing)).toBe('fail');
    expect(verdictFromGates(passing, 'quota_stop')).toBe('quota_stop');
    expect(verdictFromGates(failing, 'infra_fail')).toBe('infra_fail');
  });
});
