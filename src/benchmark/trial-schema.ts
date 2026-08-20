import { z } from 'zod';
import { TrialTraceJoinSchema } from './evidence-schema.js';
import {
  BENCHMARK_LANES,
  CANONICAL_CASE_IDS,
  FAILURE_CLASSES,
  METRIC_NAMES,
  OWNING_LAYERS,
  STREAM_MODES,
  TIMESTAMP_ONLY_EVENT_TYPES,
  type MetricName,
} from './types.js';

export const nonnegative = z.number().finite().nonnegative();
export const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const shortString = z.string().min(1).max(128);
export const safeName = shortString.regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/);
export const machineName = shortString.regex(/^[a-z0-9_]+$/);
export const LaneSchema = z.enum(BENCHMARK_LANES);
export const StreamModeSchema = z.enum(STREAM_MODES);
export const MetricNameSchema = z.enum(METRIC_NAMES);
export const FailureClassSchema = z.enum(FAILURE_CLASSES);
export const CaseIdSchema = z.enum(CANONICAL_CASE_IDS);

export const InjectionManifestEntrySchema = z.strictObject({
  kind: z.enum(['wire_tool_name', 'native_tool']),
  lane: LaneSchema,
  logicalName: safeName,
  injectedName: safeName,
});

const atMs = { atMs: nonnegative };
function event(type: z.ZodType, shape: Record<string, z.ZodType> = {}) {
  return z.strictObject({ type, ...atMs, ...shape });
}
const NormalizedEventSchema = z.union([
  event(z.enum(TIMESTAMP_ONLY_EVENT_TYPES)),
  event(z.literal('text'), {
    charCount: z.number().int().nonnegative(),
    sentinelObserved: z.boolean(),
  }),
  event(z.literal('execution_start'), { callIdHash: hash, name: safeName }),
  event(z.literal('execution_end'), {
    callIdHash: hash,
    name: safeName,
    isError: z.boolean(),
  }),
  event(z.literal('tool_args_delta'), {
    callIndex: z.number().int().nonnegative(),
    byteCount: z.number().int().nonnegative(),
  }),
  event(z.literal('complete_call'), {
    callIndex: z.number().int().nonnegative(),
    callIdHash: hash,
    name: safeName,
    argumentsHash: hash,
  }),
  event(z.literal('terminal'), {
    reason: z.enum(['completed', 'error', 'aborted']),
  }),
  event(z.literal('error'), { failureClass: FailureClassSchema }),
]);

const histogram = z.record(z.string().min(1).max(64), z.number().int().nonnegative());
const SessionTranscriptSummarySchema = z.strictObject({
  entry_kinds: histogram,
  assistant_stop_reasons: histogram,
  errored_assistant_messages: z.number().int().nonnegative(),
  user_messages: z.number().int().nonnegative(),
});
const TrialChildTraceSchema = z.strictObject({
  diagnostics: z.string().max(4_096),
  exits: z
    .array(
      z.strictObject({
        code: z.number().int().nullable(),
        signal: z.string().min(1).max(32).nullable(),
      }),
    )
    .max(8),
  session: SessionTranscriptSummarySchema.nullable(),
});

const nullableMetric = nonnegative.nullable();
const metricShape = Object.fromEntries(
  METRIC_NAMES.map((name) => [name, nullableMetric]),
) as Record<MetricName, typeof nullableMetric>;
const TrialMetricsSchema = z.strictObject(metricShape);

export const TrialRecordSchema = z.strictObject({
  case_id: CaseIdSchema,
  pair_index: z.number().int().nonnegative(),
  lane: LaneSchema,
  sentinel: z.string().regex(/^BENCH_[A-Z0-9_]+_(?:NATIVE|YORHA)_[A-F0-9]{12}$/),
  prompt_hash: hash,
  injection_manifest: z.array(InjectionManifestEntrySchema),
  stream_mode: StreamModeSchema,
  events: z.array(NormalizedEventSchema).min(1),
  trace_join: TrialTraceJoinSchema.nullable(),
  child_report: TrialChildTraceSchema,
  canonical_tool_calls: z.array(
    z.strictObject({
      call_index: z.number().int().nonnegative(),
      name: z.enum(['echo_value', 'lookup_code']),
      executed: z.boolean(),
    }),
  ),
  metrics: TrialMetricsSchema,
  passed: z.boolean(),
  failure_class: FailureClassSchema.nullable(),
  owning_layer: z.enum(OWNING_LAYERS).nullable(),
  upstream_runs: z.number().int().nonnegative(),
});
