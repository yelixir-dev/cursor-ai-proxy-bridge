import { quantile, type TrialFilterInput } from './statistics-core.js';
import {
  isInvalidPairedToolChoiceMeasurement,
  pairedCorrectnessGateId,
} from './measurement-surface.js';
import type {
  BenchmarkCase,
  BenchmarkGate,
  CanonicalCaseId,
  MetricName,
  PairedStatistic,
} from './types.js';

export const PAIRED_RATIO_MEDIAN_MAX = 1.35;
export const PAIRED_RATIO_CI_UPPER_MAX = 1.75;
export const LATENCY_GATE_METRICS: readonly MetricName[] = [
  'first_semantic_ms',
  'tool_decision_ms',
  'first_complete_call_ms',
  'turn_wall_ms',
];
const SURFACE_CASE_BY_KIND: Record<'text' | 'tool', CanonicalCaseId> = {
  text: 'text_sentinel_stream',
  tool: 'tool_auto_single',
};

export interface ResidualOverhead {
  case_id: CanonicalCaseId;
  turns: number;
  raw_gap_ms: number;
  surface_envelope_ms: number;
  residual_ms: number;
}

export interface ResidualInput extends TrialFilterInput {
  cases: readonly BenchmarkCase[];
}

function laneQuantile(
  input: TrialFilterInput,
  caseId: CanonicalCaseId,
  lane: 'native' | 'yorha',
  q: number,
): number | null {
  const values = input.trials.flatMap((trial) => {
    if (
      trial.case_id !== caseId ||
      trial.lane !== lane ||
      !input.isMeasured(trial) ||
      !trial.passed
    ) {
      return [];
    }
    const turnWallMs = trial.metrics.turn_wall_ms;
    return turnWallMs !== null ? [turnWallMs] : [];
  });
  return values.length > 0 ? quantile(values, q) : null;
}

function matchingSurface(
  testCase: BenchmarkCase,
  cases: readonly BenchmarkCase[],
): BenchmarkCase | undefined {
  const sameTools = cases.find(
    (candidate) =>
      candidate.request.turns === 1 &&
      candidate.kind === testCase.kind &&
      JSON.stringify(candidate.request.tools) === JSON.stringify(testCase.request.tools),
  );
  if (sameTools) return sameTools;
  const id = SURFACE_CASE_BY_KIND[testCase.kind === 'text' ? 'text' : 'tool'];
  return cases.find((candidate) => candidate.id === id);
}

export function computeResidualOverhead(input: ResidualInput): ResidualOverhead[] {
  const residuals: ResidualOverhead[] = [];
  for (const testCase of input.cases) {
    if (testCase.request.turns <= 1) continue;
    const yorhaMedian = laneQuantile(input, testCase.id, 'yorha', 0.5);
    const nativeMedian = laneQuantile(input, testCase.id, 'native', 0.5);
    const surface = matchingSurface(testCase, input.cases);
    const surfaceP90 = surface ? laneQuantile(input, surface.id, 'yorha', 0.9) : null;
    if (yorhaMedian === null || nativeMedian === null || surfaceP90 === null) continue;
    const rawGap = yorhaMedian - nativeMedian;
    const envelope = surfaceP90 * (testCase.request.turns - 1);
    residuals.push({
      case_id: testCase.id,
      turns: testCase.request.turns,
      raw_gap_ms: rawGap,
      surface_envelope_ms: envelope,
      residual_ms: rawGap - envelope,
    });
  }
  return residuals.sort((left, right) => left.case_id.localeCompare(right.case_id));
}

export interface CorrectnessCounts {
  case_id: CanonicalCaseId;
  passed: number;
  failed: number;
  warmup_excluded: number;
}

export function countCorrectness(input: TrialFilterInput): CorrectnessCounts[] {
  const byCase = new Map<CanonicalCaseId, CorrectnessCounts>();
  for (const trial of input.trials) {
    const entry = byCase.get(trial.case_id) ?? {
      case_id: trial.case_id,
      passed: 0,
      failed: 0,
      warmup_excluded: 0,
    };
    if (!input.isMeasured(trial)) entry.warmup_excluded += 1;
    else if (trial.passed) entry.passed += 1;
    else entry.failed += 1;
    byCase.set(trial.case_id, entry);
  }
  return [...byCase.values()].sort((left, right) => left.case_id.localeCompare(right.case_id));
}

export interface UpstreamRunMedian {
  case_id: CanonicalCaseId;
  lane: 'native' | 'yorha';
  median_upstream_runs: number;
}

export function medianUpstreamRuns(input: TrialFilterInput): UpstreamRunMedian[] {
  const groups = new Map<string, UpstreamRunMedian & { values: number[] }>();
  for (const trial of input.trials) {
    if (!input.isMeasured(trial)) continue;
    const key = `${trial.case_id}\u0000${trial.lane}`;
    const entry = groups.get(key) ?? {
      case_id: trial.case_id,
      lane: trial.lane,
      median_upstream_runs: 0,
      values: [],
    };
    entry.values.push(trial.upstream_runs);
    groups.set(key, entry);
  }
  return [...groups.values()]
    .map(({ values, ...entry }) => ({ ...entry, median_upstream_runs: quantile(values, 0.5) }))
    .sort(
      (left, right) =>
        left.case_id.localeCompare(right.case_id) || left.lane.localeCompare(right.lane),
    );
}

export interface GateEvaluationInput extends TrialFilterInput {
  profile: 'smoke' | 'ci' | 'strict';
  cases: readonly BenchmarkCase[];
  paired: readonly PairedStatistic[];
}

export function evaluateGates(input: GateEvaluationInput): BenchmarkGate[] {
  const gates: BenchmarkGate[] = input.cases.map((testCase) => {
    const measured = input.trials.filter(
      (trial) => trial.case_id === testCase.id && input.isMeasured(trial),
    );
    const failed = measured.filter(
      (trial) =>
        !trial.passed && !isInvalidPairedToolChoiceMeasurement(testCase, trial.failure_class),
    ).length;
    return {
      id: pairedCorrectnessGateId(testCase),
      case_id: testCase.id,
      metric: null,
      status: measured.length === 0 ? 'not_applicable' : failed > 0 ? 'fail' : 'pass',
      observed: failed,
      threshold: 0,
    };
  });
  if (input.profile === 'smoke') return gates;
  for (const statistic of input.paired) {
    if (!LATENCY_GATE_METRICS.includes(statistic.metric)) continue;
    const applicable = statistic.valid_pairs > 0;
    const caseKey = statistic.case_id.toLowerCase();
    const values = [
      ['latency', statistic.median_ratio, PAIRED_RATIO_MEDIAN_MAX],
      ['latency_ci', statistic.ci95.upper, PAIRED_RATIO_CI_UPPER_MAX],
    ] as const;
    for (const [kind, observed, threshold] of values) {
      gates.push({
        id: `${kind}.${caseKey}.${statistic.metric}`,
        case_id: statistic.case_id,
        metric: statistic.metric,
        status: !applicable ? 'not_applicable' : observed <= threshold ? 'pass' : 'fail',
        observed: applicable ? observed : null,
        threshold,
      });
    }
  }
  return gates.sort((left, right) => left.id.localeCompare(right.id));
}

export type BenchmarkVerdict = 'pass' | 'fail' | 'quota_stop' | 'infra_fail';

export function verdictFromGates(
  gates: readonly BenchmarkGate[],
  override: 'quota_stop' | 'infra_fail' | null = null,
): BenchmarkVerdict {
  if (override) return override;
  return gates.some((gate) => gate.status === 'fail') ? 'fail' : 'pass';
}
