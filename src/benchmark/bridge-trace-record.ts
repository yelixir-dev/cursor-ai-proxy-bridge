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
  'credential_failover',
  'retry',
  'upstream_error',
  'terminal',
  'abort',
  'backend_flip',
]);

type RetryDeclined = 'flag_off' | 'post_visible' | 'retry_limit';
type RetryReason = 'provider_5xx' | 'run_timeout';
type CredentialExclusionReason = 'auth' | 'billing' | 'cooldown';

function isRetryDeclined(value: unknown): value is RetryDeclined {
  return value === 'flag_off' || value === 'post_visible' || value === 'retry_limit';
}

function isRetryReason(value: unknown): value is RetryReason {
  return value === 'provider_5xx' || value === 'run_timeout';
}

function isCredentialExclusionReason(value: unknown): value is CredentialExclusionReason {
  return value === 'auth' || value === 'billing' || value === 'cooldown';
}

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
  retry_reason?: RetryReason;
  upstream_error_code?: string;
  upstream_error_type?: string;
  upstream_retryable?: boolean;
  provider_status_code?: string;
  run_request_id?: string;
  retry_provider_5xx?: boolean;
  retry_declined?: RetryDeclined;
  excluded_credential_slot_id?: string;
  credential_exclusion_reason?: CredentialExclusionReason;
  next_credential_slot_id?: string;
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
    'retry_reason',
    'upstream_error_code',
    'upstream_error_type',
    'upstream_retryable',
    'provider_status_code',
    'run_request_id',
    'retry_provider_5xx',
    'retry_declined',
    'excluded_credential_slot_id',
    'credential_exclusion_reason',
    'next_credential_slot_id',
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
  const upstreamErrorCode = raw.upstream_error_code;
  const upstreamErrorType = raw.upstream_error_type;
  const providerStatusCode = raw.provider_status_code;
  const runRequestId = raw.run_request_id;
  if (
    (upstreamErrorCode !== undefined &&
      (typeof upstreamErrorCode !== 'string' || !SAFE_ID.test(upstreamErrorCode))) ||
    (upstreamErrorType !== undefined &&
      (typeof upstreamErrorType !== 'string' || !SAFE_ID.test(upstreamErrorType))) ||
    (providerStatusCode !== undefined &&
      (typeof providerStatusCode !== 'string' || !SAFE_ID.test(providerStatusCode))) ||
    (runRequestId !== undefined &&
      (typeof runRequestId !== 'string' || !SAFE_ID.test(runRequestId)))
  ) {
    return null;
  }
  const upstreamRetryable = raw.upstream_retryable;
  const retryProvider5xx = raw.retry_provider_5xx;
  if (
    (upstreamRetryable !== undefined && typeof upstreamRetryable !== 'boolean') ||
    (retryProvider5xx !== undefined && typeof retryProvider5xx !== 'boolean')
  ) {
    return null;
  }
  const retryDeclined = raw.retry_declined;
  const retryReason = raw.retry_reason;
  if (retryDeclined !== undefined && !isRetryDeclined(retryDeclined)) return null;
  if (retryReason !== undefined && !isRetryReason(retryReason)) return null;
  const excludedCredentialSlotId = raw.excluded_credential_slot_id;
  const credentialExclusionReason = raw.credential_exclusion_reason;
  const nextCredentialSlotId = raw.next_credential_slot_id;
  if (
    (excludedCredentialSlotId !== undefined &&
      (typeof excludedCredentialSlotId !== 'string' ||
        !/^slot_[0-9a-f]{16}$/u.test(excludedCredentialSlotId))) ||
    (credentialExclusionReason !== undefined &&
      !isCredentialExclusionReason(credentialExclusionReason)) ||
    (nextCredentialSlotId !== undefined &&
      (typeof nextCredentialSlotId !== 'string' ||
        !/^slot_[0-9a-f]{16}$/u.test(nextCredentialSlotId))) ||
    (raw.stage === 'credential_failover' &&
      (excludedCredentialSlotId === undefined ||
        credentialExclusionReason === undefined ||
        nextCredentialSlotId === undefined))
  ) {
    return null;
  }
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
    ...(retryReason === undefined ? {} : { retry_reason: retryReason }),
    ...(upstreamErrorCode === undefined ? {} : { upstream_error_code: upstreamErrorCode }),
    ...(upstreamErrorType === undefined ? {} : { upstream_error_type: upstreamErrorType }),
    ...(upstreamRetryable === undefined ? {} : { upstream_retryable: upstreamRetryable }),
    ...(providerStatusCode === undefined ? {} : { provider_status_code: providerStatusCode }),
    ...(runRequestId === undefined ? {} : { run_request_id: runRequestId }),
    ...(retryProvider5xx === undefined ? {} : { retry_provider_5xx: retryProvider5xx }),
    ...(retryDeclined === undefined ? {} : { retry_declined: retryDeclined }),
    ...(excludedCredentialSlotId === undefined
      ? {}
      : { excluded_credential_slot_id: excludedCredentialSlotId }),
    ...(credentialExclusionReason === undefined
      ? {}
      : { credential_exclusion_reason: credentialExclusionReason }),
    ...(nextCredentialSlotId === undefined
      ? {}
      : { next_credential_slot_id: nextCredentialSlotId }),
    ...(raw.usage_source === undefined ? {} : { usage_source: raw.usage_source as UsageSource }),
    ...(raw.final_backend_state === undefined
      ? {}
      : { final_backend_state: raw.final_backend_state }),
    ...(raw.cancelled === undefined ? {} : { cancelled: raw.cancelled }),
    ...(raw.quiescent === undefined ? {} : { quiescent: raw.quiescent }),
    ...(raw.terminal === undefined ? {} : { terminal: raw.terminal }),
  };
}
