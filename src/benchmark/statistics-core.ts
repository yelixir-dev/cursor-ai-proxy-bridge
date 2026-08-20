import type {
  BenchmarkLane,
  CanonicalCaseId,
  MetricName,
  MetricStatistic,
  PairedStatistic,
  TrialRecord,
} from './types.js';

export const BOOTSTRAP_RESAMPLES = 10_000;

export function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * Math.min(Math.max(q, 0), 1);
  const base = Math.floor(position);
  const rest = position - base;
  const baseValue = sorted[base];
  const next = sorted[base + 1] ?? baseValue;
  return baseValue + (next - baseValue) * rest;
}

export interface ValueSummary {
  median: number;
  p10: number;
  p90: number;
  iqr: number;
}

export function summarize(values: readonly number[]): ValueSummary {
  const p10 = quantile(values, 0.1);
  const p90 = quantile(values, 0.9);
  return { median: quantile(values, 0.5), p10, p90, iqr: p90 - p10 };
}

export function createDeterministicRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(parts: readonly (string | number)[]): number {
  let hash = 0x811c9dc5;
  for (const part of parts.join('\u0000')) {
    hash ^= part.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function bootstrapMedianCi(
  values: readonly number[],
  seed: number,
  resamples: number = BOOTSTRAP_RESAMPLES,
): { lower: number; upper: number } {
  if (values.length === 0) return { lower: 0, upper: 0 };
  const random = createDeterministicRandom(seed);
  const medians = new Array<number>(resamples);
  for (let index = 0; index < resamples; index += 1) {
    const sample = new Array<number>(values.length);
    for (let item = 0; item < values.length; item += 1) {
      sample[item] = values[Math.floor(random() * values.length)];
    }
    medians[index] = quantile(sample, 0.5);
  }
  return { lower: quantile(medians, 0.025), upper: quantile(medians, 0.975) };
}

export interface TrialFilterInput {
  trials: readonly TrialRecord[];
  isMeasured: (trial: TrialRecord) => boolean;
}

export interface PairedFilterInput extends TrialFilterInput {
  suiteSeed: number;
}

interface MetricGroup {
  testCaseId: CanonicalCaseId;
  metric: MetricName;
  lane: BenchmarkLane;
  values: number[];
}

function validMetricSamples(input: TrialFilterInput): Map<string, MetricGroup> {
  const groups = new Map<string, MetricGroup>();
  for (const trial of input.trials) {
    if (!input.isMeasured(trial) || !trial.passed) continue;
    for (const metric of Object.keys(trial.metrics) as MetricName[]) {
      const value = trial.metrics[metric];
      if (value === null) continue;
      const key = `${trial.case_id}\u0000${metric}\u0000${trial.lane}`;
      const group = groups.get(key) ?? {
        testCaseId: trial.case_id,
        metric,
        lane: trial.lane,
        values: [],
      };
      group.values.push(value);
      groups.set(key, group);
    }
  }
  return groups;
}

export function computeMetricStatistics(input: TrialFilterInput): MetricStatistic[] {
  return [...validMetricSamples(input).values()]
    .map((group): MetricStatistic => {
      const summary = summarize(group.values);
      return {
        case_id: group.testCaseId,
        metric: group.metric,
        lane: group.lane,
        sample_count: group.values.length,
        median: summary.median,
        p10: summary.p10,
        p90: summary.p90,
        iqr: summary.iqr,
      };
    })
    .sort(
      (left, right) =>
        left.case_id.localeCompare(right.case_id) ||
        left.metric.localeCompare(right.metric) ||
        left.lane.localeCompare(right.lane),
    );
}

interface PairGroup {
  testCaseId: CanonicalCaseId;
  metric: MetricName;
  native?: number;
  yorha?: number;
}

export function computePairedStatistics(input: PairedFilterInput): PairedStatistic[] {
  const pairs = new Map<string, PairGroup>();
  for (const trial of input.trials) {
    if (!input.isMeasured(trial) || !trial.passed) continue;
    for (const metric of Object.keys(trial.metrics) as MetricName[]) {
      const key = `${trial.case_id}\u0000${metric}\u0000${trial.pair_index}`;
      const group = pairs.get(key) ?? { testCaseId: trial.case_id, metric };
      if (trial.lane === 'native') group.native = trial.metrics[metric] ?? undefined;
      else group.yorha = trial.metrics[metric] ?? undefined;
      pairs.set(key, group);
    }
  }
  const combined = new Map<string, MetricGroup>();
  for (const group of pairs.values()) {
    if (group.native === undefined || group.yorha === undefined || group.native <= 0) continue;
    const key = `${group.testCaseId}\u0000${group.metric}`;
    const target = combined.get(key) ?? {
      testCaseId: group.testCaseId,
      metric: group.metric,
      lane: 'yorha',
      values: [],
    };
    target.values.push(group.yorha / group.native);
    combined.set(key, target);
  }
  return [...combined.entries()]
    .map(
      ([key, group]): PairedStatistic => ({
        case_id: group.testCaseId,
        metric: group.metric,
        valid_pairs: group.values.length,
        median_ratio: quantile(group.values, 0.5),
        ci95: bootstrapMedianCi(group.values, hashSeed([input.suiteSeed, key])),
      }),
    )
    .sort(
      (left, right) =>
        left.case_id.localeCompare(right.case_id) || left.metric.localeCompare(right.metric),
    );
}
