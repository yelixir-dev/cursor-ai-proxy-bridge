import type { UsageSource } from './backend/types.js';

export type TraceStage =
  | 'accepted'
  | 'queue_acquired'
  | 'backend'
  | 'run_open'
  | 'h2_session_connect'
  | 'run_stream_open'
  | 'first_event'
  | 'tool_decision'
  | 'tool_batch_complete'
  | 'retry'
  | 'upstream_error'
  | 'terminal'
  | 'abort'
  | 'backend_flip';

export type TraceRetryKind = 'server' | 'transport' | 'tool_validation';
export type TraceRetryDecline = 'flag_off' | 'post_visible' | 'retry_limit';
export type TraceRetryReason = 'provider_5xx' | 'run_timeout';
export type TraceTerminal = 'success' | 'error' | 'abort' | 'rate_limited';

export interface TraceRecord {
  request_id: string;
  credential_slot_id: string | null;
  backend: string | null;
  model: string;
  upstream_run_count: number;
  retry_count: number;
  stage: TraceStage;
  offset_ms: number;
  retry_kind?: TraceRetryKind;
  retry_reason?: TraceRetryReason;
  retry_provider_5xx?: boolean;
  usage_source?: UsageSource;
  final_backend_state?: string;
  cancelled?: boolean;
  quiescent?: boolean;
  terminal?: TraceTerminal;
  tool_calls_announced?: number;
  tool_calls_completed?: number;
  upstream_error_code?: string;
  upstream_error_type?: string;
  upstream_retryable?: boolean;
  provider_status_code?: string;
  run_request_id?: string;
  retry_declined?: TraceRetryDecline;
}

export interface TraceSafeFields {
  backend?: string;
  retryKind?: TraceRetryKind;
  retryDeclined?: TraceRetryDecline;
  retryReason?: TraceRetryReason;
  retryProvider5xx?: boolean;
  usageSource?: UsageSource;
  quiescent?: boolean;
  terminal?: TraceTerminal;
  toolCallsAnnounced?: number;
  toolCallsCompleted?: number;
  upstreamErrorCode?: string;
  upstreamErrorType?: string;
  upstreamRetryable?: boolean;
  providerStatusCode?: string;
  runRequestId?: string;
}

export const onceOnlyStages = new Set<TraceStage>([
  'accepted',
  'queue_acquired',
  'backend',
  'first_event',
  'tool_decision',
  'tool_batch_complete',
  'abort',
  'terminal',
]);
const retryKinds = new Set<TraceRetryKind>(['server', 'transport', 'tool_validation']);
const retryDeclines = new Set<string>(['flag_off', 'post_visible', 'retry_limit']);
const retryReasons = new Set<string>(['provider_5xx', 'run_timeout']);
const usageSources = new Set<UsageSource>(['turnEnded', 'cli_reported', 'estimated', 'unknown']);
const terminals = new Set<TraceTerminal>(['success', 'error', 'abort', 'rate_limited']);
const safeFieldNames = new Set<keyof TraceSafeFields>([
  'backend',
  'retryKind',
  'retryDeclined',
  'retryReason',
  'retryProvider5xx',
  'usageSource',
  'quiescent',
  'terminal',
  'toolCallsAnnounced',
  'toolCallsCompleted',
  'upstreamErrorCode',
  'upstreamErrorType',
  'upstreamRetryable',
  'providerStatusCode',
  'runRequestId',
]);

export function assertSafeTraceFields(fields: unknown): asserts fields is TraceSafeFields {
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new TypeError('trace fields must be an object');
  }
  const values = fields as Record<string, unknown>;
  for (const key of Object.keys(values)) {
    if (!safeFieldNames.has(key as keyof TraceSafeFields)) {
      throw new TypeError(`unsafe trace field: ${key}`);
    }
  }
  if (values.backend !== undefined && typeof values.backend !== 'string') {
    throw new TypeError('trace backend must be a string');
  }
  if (
    values.retryKind !== undefined &&
    (typeof values.retryKind !== 'string' || !retryKinds.has(values.retryKind as TraceRetryKind))
  ) {
    throw new TypeError('invalid trace retry kind');
  }
  if (
    values.retryDeclined !== undefined &&
    (typeof values.retryDeclined !== 'string' || !retryDeclines.has(values.retryDeclined))
  ) {
    throw new TypeError('invalid trace retry decline');
  }
  if (
    values.retryReason !== undefined &&
    (typeof values.retryReason !== 'string' || !retryReasons.has(values.retryReason))
  ) {
    throw new TypeError('invalid trace retry reason');
  }
  if (values.retryProvider5xx !== undefined && typeof values.retryProvider5xx !== 'boolean') {
    throw new TypeError('trace retryProvider5xx must be a boolean');
  }
  if (
    values.usageSource !== undefined &&
    (typeof values.usageSource !== 'string' || !usageSources.has(values.usageSource as UsageSource))
  ) {
    throw new TypeError('invalid trace usage source');
  }
  if (values.quiescent !== undefined && typeof values.quiescent !== 'boolean') {
    throw new TypeError('trace quiescence must be a boolean');
  }
  for (const key of [
    'upstreamErrorCode',
    'upstreamErrorType',
    'providerStatusCode',
    'runRequestId',
  ] as const) {
    const value = values[key];
    if (value !== undefined && (typeof value !== 'string' || value.length > 96)) {
      throw new TypeError(`trace ${key} must be a bounded string`);
    }
  }
  if (values.upstreamRetryable !== undefined && typeof values.upstreamRetryable !== 'boolean') {
    throw new TypeError('trace upstreamRetryable must be a boolean');
  }
  for (const key of ['toolCallsAnnounced', 'toolCallsCompleted'] as const) {
    const count = values[key];
    if (
      count !== undefined &&
      (typeof count !== 'number' || !Number.isInteger(count) || count < 0)
    ) {
      throw new TypeError(`trace ${key} must be a non-negative integer`);
    }
  }
  if (
    values.terminal !== undefined &&
    (typeof values.terminal !== 'string' || !terminals.has(values.terminal as TraceTerminal))
  ) {
    throw new TypeError('invalid trace terminal');
  }
}
