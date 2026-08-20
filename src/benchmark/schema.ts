import { z } from 'zod';
import { requestHashForCase, sentinelFor } from './cases.js';
import {
  EvidenceAdditionsShape,
  rejectSecretKeys,
  validateCanonicalToolEvidence,
  validateEvidenceAdditions,
} from './evidence-schema.js';
import {
  CaseIdSchema,
  InjectionManifestEntrySchema,
  LaneSchema,
  MetricNameSchema,
  StreamModeSchema,
  TrialRecordSchema,
  machineName,
  nonnegative,
  safeName,
  shortString,
} from './trial-schema.js';
import {
  METRIC_NAMES,
  type BenchmarkCase,
  type BenchmarkEvidence,
  type TrialRecord,
} from './types.js';
export type { BenchmarkEvidence } from './types.js';

const CanonicalRequestSchema = z.strictObject({
  operation: machineName,
  stream: z.boolean(),
  tools: z.array(safeName),
  toolChoice: z.enum(['none', 'auto', 'required', 'forced']),
  forcedTool: safeName.nullable(),
  parallelToolCalls: z.boolean().nullable(),
  turns: z.number().int().positive(),
  malformedVariant: machineName.nullable(),
});

const CaseOracleSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('text'), exactSentinel: z.boolean() }),
  z.strictObject({
    kind: z.literal('tools'),
    names: z.array(safeName).min(1),
    ordering: z.enum(['ordered', 'multiset']),
    finalSentinel: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('http_error'),
    status: z.literal(400),
    upstreamRuns: z.literal(0),
  }),
  z.strictObject({
    kind: z.literal('cancellation'),
    after: z.enum(['first_event', 'tool_decision']),
  }),
  z.strictObject({
    kind: z.literal('concurrency'),
    isolatedSentinels: z.literal(2),
  }),
]);

function addIssue(context: z.RefinementCtx, path: PropertyKey[], message: string): void {
  context.addIssue({ code: 'custom', path, message });
}

export const BenchmarkCaseSchema = z
  .strictObject({
    id: CaseIdSchema,
    kind: z.enum(['text', 'tool', 'malformed', 'cancellation', 'concurrency', 'cold_boot']),
    streamModes: z.strictObject({
      native: StreamModeSchema,
      yorha: StreamModeSchema,
    }),
    nullMetrics: z.array(MetricNameSchema),
    request: CanonicalRequestSchema,
    injectionManifest: z.array(InjectionManifestEntrySchema),
    oracle: CaseOracleSchema,
  })
  .superRefine((testCase, context) => {
    const seen = new Set<string>();
    testCase.nullMetrics.forEach((metric, index) => {
      if (seen.has(metric)) addIssue(context, ['nullMetrics', index], 'duplicate metric');
      seen.add(metric);
    });
    const isForced = testCase.request.toolChoice === 'forced';
    if (isForced !== (testCase.request.forcedTool !== null))
      addIssue(context, ['request', 'forcedTool'], 'forced tool mismatch');
  });

const StatisticSchema = z.union([
  z.strictObject({
    case_id: CaseIdSchema,
    metric: MetricNameSchema,
    lane: LaneSchema,
    sample_count: z.number().int().nonnegative(),
    median: nonnegative,
    p10: nonnegative,
    p90: nonnegative,
    iqr: nonnegative,
  }),
  z.strictObject({
    case_id: CaseIdSchema,
    metric: MetricNameSchema,
    valid_pairs: z.number().int().nonnegative(),
    median_ratio: nonnegative,
    ci95: z.strictObject({ lower: nonnegative, upper: nonnegative }),
  }),
]);

const GateSchema = z.strictObject({
  id: shortString.regex(/^[a-z0-9_.-]+$/),
  case_id: CaseIdSchema.nullable(),
  metric: MetricNameSchema.nullable(),
  status: z.enum(['pass', 'fail', 'not_applicable']),
  observed: nonnegative.nullable(),
  threshold: nonnegative.nullable(),
});

const BaseEvidenceSchema = z
  .strictObject({
    schema_version: z.literal('cursor-composer-parity-metrics/v1'),
    suite: z.strictObject({
      seed: z.number().int().nonnegative(),
      profile: z.enum(['smoke', 'ci', 'strict']),
      generated_at: z.string().datetime({ offset: true }),
    }),
    environment: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
    cases: z.array(BenchmarkCaseSchema).min(1),
    trials: z.array(TrialRecordSchema),
    statistics: z.array(StatisticSchema),
    ...EvidenceAdditionsShape,
    gates: z.array(GateSchema),
    verdict: z.enum(['pass', 'fail', 'quota_stop', 'infra_fail']),
  })
  .superRefine((evidence, context) => {
    const cases = new Map<string, BenchmarkCase>();
    evidence.cases.forEach((testCase, index) => {
      if (cases.has(testCase.id)) addIssue(context, ['cases', index, 'id'], 'duplicate case id');
      else cases.set(testCase.id, testCase);
    });
    const trials = new Set<string>();
    evidence.trials.forEach((trial, index) => {
      const key = `${trial.case_id}:${trial.pair_index}:${trial.lane}`;
      if (trials.has(key)) addIssue(context, ['trials', index], 'duplicate trial');
      trials.add(key);
      const testCase = cases.get(trial.case_id);
      if (!testCase) {
        addIssue(context, ['trials', index, 'case_id'], 'case is not declared');
        return;
      }
      for (const metric of METRIC_NAMES) {
        const mustBeNull = testCase.nullMetrics.includes(metric);
        if (mustBeNull !== (trial.metrics[metric] === null))
          addIssue(
            context,
            ['trials', index, 'metrics', metric],
            mustBeNull ? 'metric is not applicable' : 'metric is required',
          );
      }
      if (trial.stream_mode !== testCase.streamModes[trial.lane])
        addIssue(context, ['trials', index, 'stream_mode'], 'lane stream mode mismatch');
      if (JSON.stringify(trial.injection_manifest) !== JSON.stringify(testCase.injectionManifest))
        addIssue(context, ['trials', index, 'injection_manifest'], 'injection manifest mismatch');
      if (trial.prompt_hash !== requestHashForCase(testCase))
        addIssue(context, ['trials', index, 'prompt_hash'], 'canonical request hash mismatch');
      const expected = sentinelFor(
        trial.case_id,
        evidence.suite.seed,
        trial.pair_index,
        trial.lane,
      );
      if (trial.sentinel !== expected)
        addIssue(context, ['trials', index, 'sentinel'], 'sentinel mismatch');
      if (trial.passed !== (trial.failure_class === null))
        addIssue(context, ['trials', index, 'failure_class'], 'failure/verdict mismatch');
      if ((trial.failure_class === null) !== (trial.owning_layer === null))
        addIssue(context, ['trials', index, 'owning_layer'], 'failure owner mismatch');
      validateCanonicalToolEvidence(trial as TrialRecord, testCase, index, context);
    });
    validateEvidenceAdditions(evidence as BenchmarkEvidence, context);
  });

export const BenchmarkEvidenceSchema = z
  .unknown()
  .superRefine((value, context) => rejectSecretKeys(value, context))
  .pipe(BaseEvidenceSchema);
