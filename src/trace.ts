import { performance } from 'node:perf_hooks';
import type { CursorProviderErrorDiagnostics } from './backend/cursor-api/provider-error.js';
import type { UsageSource } from './backend/types.js';
import type {
  TraceRecord,
  TraceRetryDecline,
  TraceRetryKind,
  TraceRetryReason,
  TraceSafeFields,
  TraceStage,
  TraceTerminal,
} from './trace-contract.js';
import { assertSafeTraceFields, onceOnlyStages } from './trace-contract.js';

export type {
  TraceCredentialExclusionReason,
  TraceRecord,
  TraceRetryDecline,
  TraceRetryKind,
  TraceRetryReason,
  TraceSafeFields,
  TraceStage,
  TraceTerminal,
} from './trace-contract.js';
export { assertSafeTraceFields } from './trace-contract.js';
export { credentialSlotId, traceCredentialSlot } from './trace-credential-slot.js';

export type TraceSink = (record: TraceRecord) => void;

export interface RequestTraceOptions {
  environment?: NodeJS.ProcessEnv;
  requestId: string;
  model: string;
  sink?: TraceSink;
  now?: () => number;
}

export interface ServerTraceOptions {
  environment?: NodeJS.ProcessEnv;
  sink?: TraceSink;
  now?: () => number;
}

export interface RequestTrace {
  readonly requestId: string;
  readonly model: string;
  readonly startedAt: number;
  readonly sink: TraceSink;
  readonly now: () => number;
  backend: string | null;
  credentialSlotId: string | null;
  upstreamRunCount: number;
  retryCount: number;
  retryKind?: TraceRetryKind;
  retryProvider5xx?: boolean;
  usageSource: UsageSource;
  terminalEmitted: boolean;
  readonly onceStages: Set<TraceStage>;
}

const REQUEST_TRACE = Symbol('cursorBridgeRequestTrace');

interface TraceableRequest {
  [REQUEST_TRACE]?: RequestTrace;
}

function defaultSink(record: TraceRecord): void {
  process.stderr.write(`${JSON.stringify(record)}\n`);
}

function defaultNow(): number {
  return performance.now();
}

export function createRequestTrace(options: RequestTraceOptions): RequestTrace | undefined {
  if ((options.environment ?? process.env).CURSOR_BRIDGE_TRACE !== '1') return undefined;
  const now = options.now ?? defaultNow;
  return {
    requestId: options.requestId,
    model: options.model,
    startedAt: now(),
    sink: options.sink ?? defaultSink,
    now,
    backend: null,
    credentialSlotId: null,
    upstreamRunCount: 0,
    retryCount: 0,
    usageSource: 'unknown',
    terminalEmitted: false,
    onceStages: new Set<TraceStage>(),
  };
}

export function attachRequestTrace(request: object, trace: RequestTrace | undefined): void {
  if (!trace) return;
  Object.defineProperty(request, REQUEST_TRACE, {
    configurable: false,
    enumerable: false,
    value: trace,
    writable: false,
  });
}

export function requestTrace(request: object): RequestTrace | undefined {
  return (request as TraceableRequest)[REQUEST_TRACE];
}

export function traceStage(
  trace: RequestTrace | undefined,
  stage: TraceStage,
  fields: TraceSafeFields = {},
): void {
  if (!trace || trace.terminalEmitted) return;
  assertSafeTraceFields(fields);
  if (onceOnlyStages.has(stage)) {
    if (trace.onceStages.has(stage)) return;
    trace.onceStages.add(stage);
  }
  const backend = fields.backend ?? trace.backend;
  const retryProvider5xx = fields.retryProvider5xx ?? trace.retryProvider5xx;
  const record: TraceRecord = {
    request_id: trace.requestId,
    credential_slot_id: trace.credentialSlotId,
    backend,
    model: trace.model,
    upstream_run_count: trace.upstreamRunCount,
    retry_count: trace.retryCount,
    stage,
    offset_ms: Math.max(0, trace.now() - trace.startedAt),
    ...(trace.retryKind === undefined ? {} : { retry_kind: trace.retryKind }),
    ...(fields.retryDeclined === undefined ? {} : { retry_declined: fields.retryDeclined }),
    ...(fields.retryReason === undefined ? {} : { retry_reason: fields.retryReason }),
    ...(retryProvider5xx === undefined ? {} : { retry_provider_5xx: retryProvider5xx }),
    ...(fields.excludedCredentialSlotId === undefined
      ? {}
      : { excluded_credential_slot_id: fields.excludedCredentialSlotId }),
    ...(fields.credentialExclusionReason === undefined
      ? {}
      : { credential_exclusion_reason: fields.credentialExclusionReason }),
    ...(fields.nextCredentialSlotId === undefined
      ? {}
      : { next_credential_slot_id: fields.nextCredentialSlotId }),
    ...(fields.credentialPlan === undefined ? {} : { credential_plan: fields.credentialPlan }),
    ...(fields.credentialEligibility === undefined
      ? {}
      : { credential_eligibility: fields.credentialEligibility }),
    ...(fields.routingPolicy === undefined ? {} : { routing_policy: fields.routingPolicy }),
    ...(fields.ultraReserveBypassed === undefined
      ? {}
      : { ultra_reserve_bypassed: fields.ultraReserveBypassed }),
    ...(fields.toolCallsAnnounced === undefined
      ? {}
      : { tool_calls_announced: fields.toolCallsAnnounced }),
    ...(fields.toolCallsCompleted === undefined
      ? {}
      : { tool_calls_completed: fields.toolCallsCompleted }),
    ...(fields.upstreamErrorCode === undefined
      ? {}
      : { upstream_error_code: fields.upstreamErrorCode }),
    ...(fields.upstreamErrorType === undefined
      ? {}
      : { upstream_error_type: fields.upstreamErrorType }),
    ...(fields.upstreamRetryable === undefined
      ? {}
      : { upstream_retryable: fields.upstreamRetryable }),
    ...(fields.providerStatusCode === undefined
      ? {}
      : { provider_status_code: fields.providerStatusCode }),
    ...(fields.runRequestId === undefined ? {} : { run_request_id: fields.runRequestId }),
    ...(fields.terminal === undefined
      ? {}
      : {
          usage_source: fields.usageSource ?? trace.usageSource,
          final_backend_state: trace.backend ?? 'unknown',
          cancelled: fields.terminal === 'abort',
          quiescent: fields.quiescent ?? false,
          terminal: fields.terminal,
        }),
  };
  try {
    trace.sink(record);
  } catch {
    // Opt-in diagnostics must not alter completion, retry, or routing behavior.
  }
}

export function traceBackend(trace: RequestTrace | undefined, backend: string): void {
  if (!trace || trace.onceStages.has('backend')) return;
  trace.backend = backend;
  traceStage(trace, 'backend');
}

export function traceRetryProvider5xxPolicy(
  trace: RequestTrace | undefined,
  enabled: boolean,
): void {
  if (!trace) return;
  trace.retryProvider5xx = enabled;
}

export function traceRunOpen(
  trace: RequestTrace | undefined,
  backend: string,
  runRequestId?: string,
): void {
  if (!trace || trace.terminalEmitted) return;
  trace.upstreamRunCount += 1;
  traceStage(trace, 'run_open', {
    backend,
    ...(runRequestId === undefined ? {} : { runRequestId }),
  });
}

export function traceRetry(
  trace: RequestTrace | undefined,
  kind: TraceRetryKind,
  reason?: TraceRetryReason,
): void {
  if (!trace || trace.terminalEmitted) return;
  trace.retryCount += 1;
  trace.retryKind = kind;
  traceStage(trace, 'retry', {
    retryKind: kind,
    ...(reason === undefined ? {} : { retryReason: reason }),
  });
}

export function traceUpstreamError(
  trace: RequestTrace | undefined,
  diagnostics: CursorProviderErrorDiagnostics | undefined,
  decline?: TraceRetryDecline,
): void {
  if (!diagnostics) return;
  traceStage(trace, 'upstream_error', {
    ...(diagnostics.connectCode === undefined
      ? {}
      : { upstreamErrorCode: diagnostics.connectCode }),
    ...(diagnostics.upstreamErrorType === undefined
      ? {}
      : { upstreamErrorType: diagnostics.upstreamErrorType }),
    ...(diagnostics.upstreamRetryable === undefined
      ? {}
      : { upstreamRetryable: diagnostics.upstreamRetryable }),
    ...(diagnostics.providerStatusCode === undefined
      ? {}
      : { providerStatusCode: diagnostics.providerStatusCode }),
    ...(diagnostics.runRequestId === undefined ? {} : { runRequestId: diagnostics.runRequestId }),
    ...(decline === undefined ? {} : { retryDeclined: decline }),
  });
}

export function traceUsageSource(trace: RequestTrace | undefined, source: UsageSource): void {
  if (!trace || trace.terminalEmitted) return;
  trace.usageSource = source;
}

export function traceBackendFlip(trace: RequestTrace | undefined, backend: string): void {
  if (!trace || trace.terminalEmitted) return;
  trace.backend = backend;
  traceStage(trace, 'backend_flip', { backend });
}

export function finishTrace(
  trace: RequestTrace | undefined,
  terminal: TraceTerminal,
  fields: Pick<TraceSafeFields, 'quiescent' | 'usageSource'> = {},
): void {
  if (!trace || trace.terminalEmitted) return;
  if (terminal === 'abort') traceStage(trace, 'abort', { terminal });
  traceStage(trace, 'terminal', { ...fields, terminal });
  trace.terminalEmitted = true;
}
