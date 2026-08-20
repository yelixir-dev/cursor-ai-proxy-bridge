import type { TrialChildTrace } from './child-trace.js';
import type { TrialTraceJoin } from './lifecycle-types.js';
export type { TrialTraceJoin } from './lifecycle-types.js';
import type { BenchmarkCompanions, FirstDivergence, OverheadRow } from './evidence-types.js';
export type {
  BenchmarkCompanions,
  CompanionFileReference,
  CompanionKind,
  FirstDivergence,
  OverheadRow,
} from './evidence-types.js';

export const BENCHMARK_LANES = ['native', 'yorha'] as const;
export type BenchmarkLane = (typeof BENCHMARK_LANES)[number];

export const STREAM_MODES = ['incremental', 'buffered', 'nonstream'] as const;
export type StreamMode = (typeof STREAM_MODES)[number];

export const METRIC_NAMES = [
  'accepted_ms',
  'first_byte_ms',
  'first_semantic_ms',
  'tool_decision_ms',
  'first_complete_call_ms',
  'all_complete_calls_ms',
  'tool_execution_ms',
  'terminal_ms',
  'cancellation_ms',
  'turn_wall_ms',
  'total_loop_ms',
] as const;
export type MetricName = (typeof METRIC_NAMES)[number];
export type TrialMetrics = { [Name in MetricName]: number | null };

export const FAILURE_CLASSES = [
  'sentinel_mismatch',
  'hallucinated_tool',
  'substituted_builtin',
  'invalid_tool_args',
  'duplicate_tool_call',
  'missing_tool_call',
  'unexpected_tool',
  'tool_order_mismatch',
  'tool_id_replay_mismatch',
  'missing_terminal',
  'late_after_abort',
  'crosstalk',
  'schema_recovery_failed',
  'invalid_request_accepted',
  'cancel_failed',
  'prompt_mismatch',
  'backend_flip',
  'rate_limit',
  'quota',
  'quota_stop',
  'auth',
  'transport',
  'timeout',
  'malformed_jsonl',
  'stdout_overflow',
  'stderr_overflow',
  'evidence_io_failure',
  'early_exit',
  'lingering_descendant',
  'missing_model',
  'harness_version_mismatch',
  'harness_failure',
  'infra_fail',
] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

export const OWNING_LAYERS = [
  'model_metadata',
  'request_history_mapper',
  'tool_scheduling',
  'stream_adapter',
  'transport',
  'retry_cancel_lifecycle',
  'backend_routing',
  'openai_surface_tax',
  'model_variance',
  'infrastructure',
  'harness',
] as const;
export type OwningLayer = (typeof OWNING_LAYERS)[number];

export const CANONICAL_CASE_IDS = [
  'text_sentinel_stream',
  'text_sentinel_nostream',
  'text_long_stream',
  'tool_auto_single',
  'tool_parallel_two',
  'tool_sequential_two_round',
  'tool_history_replay',
  'tool_parallel_false_cap',
  'toolChoice_none',
  'toolChoice_required',
  'toolChoice_forced',
  'tool_schema_recovery',
  'malformed_unknown_forced_name',
  'malformed_required_without_tools',
  'malformed_duplicate_tool_names',
  'malformed_orphan_tool_call_id',
  'malformed_duplicate_tool_call_ids',
  'malformed_json',
  'cancel_after_first_event',
  'cancel_mid_tool',
  'client_parallel_two',
  'cold_boot_text',
] as const;
export type CanonicalCaseId = (typeof CANONICAL_CASE_IDS)[number];
export type CaseKind = 'text' | 'tool' | 'malformed' | 'cancellation' | 'concurrency' | 'cold_boot';
export type ToolChoiceMode = 'none' | 'auto' | 'required' | 'forced';

export interface InjectionManifestEntry {
  kind: 'wire_tool_name' | 'native_tool';
  lane: BenchmarkLane;
  logicalName: string;
  injectedName: string;
}

export interface CanonicalRequest {
  operation: string;
  stream: boolean;
  tools: string[];
  toolChoice: ToolChoiceMode;
  forcedTool: string | null;
  parallelToolCalls: boolean | null;
  turns: number;
  malformedVariant: string | null;
}

export type CaseOracle =
  | { kind: 'text'; exactSentinel: boolean }
  | {
      kind: 'tools';
      names: string[];
      ordering: 'ordered' | 'multiset';
      finalSentinel: boolean;
    }
  | { kind: 'http_error'; status: 400; upstreamRuns: 0 }
  | { kind: 'cancellation'; after: 'first_event' | 'tool_decision' }
  | { kind: 'concurrency'; isolatedSentinels: 2 };

export interface BenchmarkCase {
  id: CanonicalCaseId;
  kind: CaseKind;
  streamModes: Record<BenchmarkLane, StreamMode>;
  nullMetrics: MetricName[];
  request: CanonicalRequest;
  injectionManifest: InjectionManifestEntry[];
  oracle: CaseOracle;
}

export const TIMESTAMP_ONLY_EVENT_TYPES = [
  'accepted',
  'first_byte',
  'thinking',
  'tool_decision',
  'aborted',
] as const;

export type NormalizedEvent =
  | { type: (typeof TIMESTAMP_ONLY_EVENT_TYPES)[number]; atMs: number }
  | { type: 'text'; atMs: number; charCount: number; sentinelObserved: boolean }
  | { type: 'execution_start'; atMs: number; callIdHash: string; name: string }
  | {
      type: 'execution_end';
      atMs: number;
      callIdHash: string;
      name: string;
      isError: boolean;
    }
  | {
      type: 'tool_args_delta';
      atMs: number;
      callIndex: number;
      byteCount: number;
    }
  | {
      type: 'complete_call';
      atMs: number;
      callIndex: number;
      callIdHash: string;
      name: string;
      argumentsHash: string;
    }
  | {
      type: 'terminal';
      atMs: number;
      reason: 'completed' | 'error' | 'aborted';
    }
  | { type: 'error'; atMs: number; failureClass: FailureClass };

export interface CanonicalToolCallReceipt {
  call_index: number;
  name: 'echo_value' | 'lookup_code';
  executed: boolean;
}

export interface TrialRecord {
  case_id: CanonicalCaseId;
  pair_index: number;
  lane: BenchmarkLane;
  sentinel: string;
  prompt_hash: string;
  injection_manifest: InjectionManifestEntry[];
  stream_mode: StreamMode;
  events: NormalizedEvent[];
  canonical_tool_calls: CanonicalToolCallReceipt[];
  trace_join: TrialTraceJoin | null;
  child_report: TrialChildTrace;
  metrics: TrialMetrics;
  passed: boolean;
  failure_class: FailureClass | null;
  owning_layer: OwningLayer | null;
  upstream_runs: number;
}

export interface MetricStatistic {
  case_id: CanonicalCaseId;
  metric: MetricName;
  lane: BenchmarkLane;
  sample_count: number;
  median: number;
  p10: number;
  p90: number;
  iqr: number;
}

export interface PairedStatistic {
  case_id: CanonicalCaseId;
  metric: MetricName;
  valid_pairs: number;
  median_ratio: number;
  ci95: { lower: number; upper: number };
}

export interface BenchmarkGate {
  id: string;
  case_id: CanonicalCaseId | null;
  metric: MetricName | null;
  status: 'pass' | 'fail' | 'not_applicable';
  observed: number | null;
  threshold: number | null;
}

export interface BenchmarkEvidence {
  schema_version: 'cursor-composer-parity-metrics/v1';
  suite: {
    seed: number;
    profile: 'smoke' | 'ci' | 'strict';
    generated_at: string;
  };
  environment: Record<string, string | number | boolean | null>;
  cases: BenchmarkCase[];
  trials: TrialRecord[];
  statistics: Array<MetricStatistic | PairedStatistic>;
  overhead: OverheadRow[];
  first_divergences: FirstDivergence[];
  companions: BenchmarkCompanions;
  gates: BenchmarkGate[];
  verdict: 'pass' | 'fail' | 'quota_stop' | 'infra_fail';
}
