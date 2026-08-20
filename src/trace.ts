import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
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
  | 'terminal'
  | 'abort'
  | 'backend_flip';

export type TraceRetryKind = 'server' | 'transport' | 'tool_validation';
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
  usage_source?: UsageSource;
  final_backend_state?: string;
  cancelled?: boolean;
  quiescent?: boolean;
  terminal?: TraceTerminal;
}

export interface TraceSafeFields {
  backend?: string;
  retryKind?: TraceRetryKind;
  usageSource?: UsageSource;
  quiescent?: boolean;
  terminal?: TraceTerminal;
}

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
  usageSource: UsageSource;
  terminalEmitted: boolean;
  readonly onceStages: Set<TraceStage>;
}

const REQUEST_TRACE = Symbol('cursorBridgeRequestTrace');
const onceOnlyStages = new Set<TraceStage>([
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
const usageSources = new Set<UsageSource>(['turnEnded', 'cli_reported', 'estimated', 'unknown']);
const terminals = new Set<TraceTerminal>(['success', 'error', 'abort', 'rate_limited']);
const safeFieldNames = new Set<keyof TraceSafeFields>([
  'backend',
  'retryKind',
  'usageSource',
  'quiescent',
  'terminal',
]);

interface TraceableRequest {
  [REQUEST_TRACE]?: RequestTrace;
}

function defaultSink(record: TraceRecord): void {
  process.stderr.write(`${JSON.stringify(record)}\n`);
}

function defaultNow(): number {
  return performance.now();
}

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
    values.usageSource !== undefined &&
    (typeof values.usageSource !== 'string' || !usageSources.has(values.usageSource as UsageSource))
  ) {
    throw new TypeError('invalid trace usage source');
  }
  if (values.quiescent !== undefined && typeof values.quiescent !== 'boolean') {
    throw new TypeError('trace quiescence must be a boolean');
  }
  if (
    values.terminal !== undefined &&
    (typeof values.terminal !== 'string' || !terminals.has(values.terminal as TraceTerminal))
  ) {
    throw new TypeError('invalid trace terminal');
  }
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

export function traceCredentialSlot(trace: RequestTrace | undefined, credentialId: string): void {
  if (!trace || trace.credentialSlotId !== null) return;
  const digest = createHash('sha256').update(credentialId).digest('hex').slice(0, 16);
  trace.credentialSlotId = `slot_${digest}`;
}

export function traceRunOpen(trace: RequestTrace | undefined, backend: string): void {
  if (!trace || trace.terminalEmitted) return;
  trace.upstreamRunCount += 1;
  traceStage(trace, 'run_open', { backend });
}

export function traceRetry(trace: RequestTrace | undefined, kind: TraceRetryKind): void {
  if (!trace || trace.terminalEmitted) return;
  trace.retryCount += 1;
  trace.retryKind = kind;
  traceStage(trace, 'retry', { retryKind: kind });
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
