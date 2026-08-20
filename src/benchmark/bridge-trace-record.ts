import type { UsageSource } from '../backend/types.js';

const SAFE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const TRACE_STAGES = new Set([
  'accepted',
  'queue_acquired',
  'backend',
  'run_open',
  'h2_session_connect',
  'run_stream_open',
  'first_event',
  'tool_decision',
  'tool_batch_complete',
  'retry',
  'terminal',
  'abort',
  'backend_flip',
]);

export interface SanitizedBridgeTraceRecord {
  sequence: number;
  request_id: string;
  credential_slot_id: string | null;
  backend: string | null;
  model: string;
  upstream_run_count: number;
  retry_count?: number;
  stage: string;
  offset_ms: number;
  retry_kind?: string;
  usage_source?: UsageSource;
  final_backend_state?: string;
  cancelled?: boolean;
  quiescent?: boolean;
  terminal?: string;
}

export function parseTraceRecord(
  value: unknown,
  sequence: number,
): SanitizedBridgeTraceRecord | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const allowed = new Set([
    'request_id',
    'credential_slot_id',
    'backend',
    'model',
    'upstream_run_count',
    'retry_count',
    'stage',
    'offset_ms',
    'retry_kind',
    'usage_source',
    'final_backend_state',
    'cancelled',
    'quiescent',
    'terminal',
  ]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) return null;
  if (
    typeof raw.request_id !== 'string' ||
    !SAFE_ID.test(raw.request_id) ||
    (raw.credential_slot_id !== null &&
      (typeof raw.credential_slot_id !== 'string' || !SAFE_ID.test(raw.credential_slot_id))) ||
    (raw.backend !== null && (typeof raw.backend !== 'string' || !SAFE_ID.test(raw.backend))) ||
    typeof raw.model !== 'string' ||
    !SAFE_ID.test(raw.model) ||
    typeof raw.stage !== 'string' ||
    !TRACE_STAGES.has(raw.stage) ||
    typeof raw.upstream_run_count !== 'number' ||
    !Number.isInteger(raw.upstream_run_count) ||
    raw.upstream_run_count < 0 ||
    typeof raw.offset_ms !== 'number' ||
    !Number.isFinite(raw.offset_ms) ||
    raw.offset_ms < 0
  ) {
    return null;
  }
  const retryCount = raw.retry_count === undefined ? 0 : raw.retry_count;
  if (typeof retryCount !== 'number' || !Number.isInteger(retryCount) || retryCount < 0)
    return null;
  if (raw.retry_kind !== undefined && typeof raw.retry_kind !== 'string') return null;
  if (raw.stage === 'retry' && (raw.retry_kind === undefined || retryCount === 0)) return null;
  if (
    raw.usage_source !== undefined &&
    !['turnEnded', 'cli_reported', 'estimated', 'unknown'].includes(String(raw.usage_source))
  ) {
    return null;
  }
  if (
    raw.usage_source === 'estimated' &&
    (raw.backend === 'cursor-api' || raw.final_backend_state === 'cursor-api')
  ) {
    return null;
  }
  if (
    raw.final_backend_state !== undefined &&
    (typeof raw.final_backend_state !== 'string' || !SAFE_ID.test(raw.final_backend_state))
  ) {
    return null;
  }
  if (raw.cancelled !== undefined && typeof raw.cancelled !== 'boolean') return null;
  if (raw.quiescent !== undefined && typeof raw.quiescent !== 'boolean') return null;
  if (raw.terminal !== undefined && typeof raw.terminal !== 'string') return null;
  return {
    sequence,
    request_id: raw.request_id,
    credential_slot_id: raw.credential_slot_id as string | null,
    backend: raw.backend as string | null,
    model: raw.model,
    upstream_run_count: raw.upstream_run_count,
    retry_count: retryCount,
    stage: raw.stage,
    offset_ms: raw.offset_ms,
    ...(raw.retry_kind === undefined ? {} : { retry_kind: raw.retry_kind }),
    ...(raw.usage_source === undefined ? {} : { usage_source: raw.usage_source as UsageSource }),
    ...(raw.final_backend_state === undefined
      ? {}
      : { final_backend_state: raw.final_backend_state }),
    ...(raw.cancelled === undefined ? {} : { cancelled: raw.cancelled }),
    ...(raw.quiescent === undefined ? {} : { quiescent: raw.quiescent }),
    ...(raw.terminal === undefined ? {} : { terminal: raw.terminal }),
  };
}
