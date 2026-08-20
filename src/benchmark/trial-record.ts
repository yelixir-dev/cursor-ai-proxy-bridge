import type { AccountComparability } from './account-comparability.js';
import { requestHashForCase } from './cases.js';
import type { TrialChildTrace } from './child-trace.js';
import { observeEvents } from './normalize.js';
import { trialOwningLayer } from './measurement-surface.js';
import { judgeOracle, type ExpectedToolCall } from './oracle.js';
import { childReportFailure } from './turn-failure.js';
import type {
  BenchmarkCase,
  BenchmarkLane,
  FailureClass,
  NormalizedEvent,
  TrialMetrics,
  TrialRecord,
  TrialTraceJoin,
} from './types.js';

export { isInfraStop, isQuotaStop, owningLayerFor } from './failure-owners.js';

export interface LaneTrialRequest {
  testCase: BenchmarkCase;
  pairIndex: number;
  phase: 'warmup' | 'measured';
  lane: BenchmarkLane;
  sentinel: string;
  peerSentinels: readonly string[];
  prompt: string;
  promptHash: string;
  expectedCalls: readonly ExpectedToolCall[];
  omoSeed: string;
  concurrency: number;
  signal: AbortSignal;
}

export interface LaneTrialSample {
  rawEvents: readonly unknown[];
  durationMs: number;
  upstreamRuns: number;
  failureClass: FailureClass | null;
  promptHash: string | null;
  httpStatus: number | null;
  isolatedSentinels: readonly string[] | null;
  traceJoin: TrialTraceJoin | null;
  childReport: TrialChildTrace;
}

export interface PreflightSnapshot {
  ok: boolean;
  activeBackend: string;
  bridgeVersion: string;
  accountComparability: AccountComparability;
}

function firstAt(events: readonly NormalizedEvent[], type: NormalizedEvent['type']): number | null {
  const found = events.find((event) => event.type === type);
  return found ? found.atMs : null;
}

function lastAt(events: readonly NormalizedEvent[], type: NormalizedEvent['type']): number | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === type) return event.atMs;
  }
  return null;
}

export function deriveTrialMetrics(
  events: readonly NormalizedEvent[],
  durationMs: number,
): TrialMetrics {
  const lastEventAt = events.at(-1)?.atMs ?? 0;
  const executionStart = firstAt(events, 'execution_start');
  const executionEnd = lastAt(events, 'execution_end');
  const semanticEnd = Math.max(
    lastAt(events, 'text') ?? 0,
    lastAt(events, 'complete_call') ?? 0,
    executionEnd ?? 0,
  );
  return {
    accepted_ms: firstAt(events, 'accepted') ?? 0,
    first_byte_ms: firstAt(events, 'first_byte') ?? lastEventAt,
    first_semantic_ms: firstAt(events, 'text') ?? lastEventAt,
    tool_decision_ms: firstAt(events, 'tool_decision') ?? lastEventAt,
    first_complete_call_ms: firstAt(events, 'complete_call') ?? lastEventAt,
    all_complete_calls_ms: lastAt(events, 'complete_call') ?? lastEventAt,
    tool_execution_ms:
      executionStart !== null && executionEnd !== null
        ? executionEnd - executionStart
        : lastEventAt,
    terminal_ms: firstAt(events, 'terminal') ?? durationMs,
    cancellation_ms: firstAt(events, 'aborted') ?? durationMs,
    turn_wall_ms: semanticEnd > 0 ? semanticEnd : durationMs,
    total_loop_ms: durationMs,
  };
}

function finalizeMetrics(testCase: BenchmarkCase, metrics: TrialMetrics): TrialMetrics {
  return Object.fromEntries(
    (Object.keys(metrics) as Array<keyof TrialMetrics>).map((metric) => [
      metric,
      testCase.nullMetrics.includes(metric) ? null : metrics[metric],
    ]),
  ) as TrialMetrics;
}

function authoritativeFailure(
  request: LaneTrialRequest,
  sample: LaneTrialSample,
  visibleText: string,
): FailureClass | null {
  const oracle = request.testCase.oracle;
  if (oracle.kind === 'http_error') {
    return sample.httpStatus === oracle.status && sample.upstreamRuns === oracle.upstreamRuns
      ? null
      : 'invalid_request_accepted';
  }
  if (oracle.kind === 'concurrency') {
    const required = [request.sentinel, ...request.peerSentinels];
    const observed = new Set(sample.isolatedSentinels ?? []);
    const receiptsMatch =
      observed.size === required.length && required.every((sentinel) => observed.has(sentinel));
    return receiptsMatch && required.every((sentinel) => visibleText.includes(sentinel))
      ? null
      : 'sentinel_mismatch';
  }
  return null;
}

export function assembleTrialRecord(
  request: LaneTrialRequest,
  sample: LaneTrialSample,
): TrialRecord {
  const isConcurrency = request.testCase.oracle.kind === 'concurrency';
  const observation = observeEvents(sample.rawEvents, {
    sentinel: request.sentinel,
    peerSentinels: isConcurrency ? [] : request.peerSentinels,
  });
  const promptMismatch =
    sample.promptHash !== null && sample.promptHash !== request.promptHash
      ? 'prompt_mismatch'
      : null;
  const join = sample.traceJoin;
  const childFailure = childReportFailure({
    erroredAssistantTurns: Math.max(
      observation.erroredAssistantTurns,
      sample.childReport.session?.errored_assistant_messages ?? 0,
    ),
    assistantErrorText: observation.assistantErrorText,
    diagnostics: sample.childReport.diagnostics,
  });
  const backendFlip =
    request.lane === 'yorha' &&
    join !== null &&
    ((join.active_backend !== undefined &&
      join.active_backend !== null &&
      join.active_backend !== 'cursor-api') ||
      (join.final_backend_state !== undefined &&
        join.final_backend_state !== null &&
        join.final_backend_state !== 'cursor-api'))
      ? 'backend_flip'
      : null;
  const invalidYorhaJoin =
    request.lane === 'yorha' &&
    sample.failureClass === null &&
    (join === null ||
      !join.synchronized ||
      join.attributed_run_count !== sample.upstreamRuns ||
      (request.testCase.kind !== 'malformed' &&
        (join.attributed_run_count === 0 || join.request_ids.length === 0)))
      ? 'infra_fail'
      : null;
  const resolvedClass =
    promptMismatch ??
    childFailure ??
    backendFlip ??
    invalidYorhaJoin ??
    authoritativeFailure(request, sample, observation.visibleText) ??
    sample.failureClass ??
    judgeOracle({
      events: sample.rawEvents,
      oracle: request.testCase.oracle,
      sentinel: request.sentinel,
      expectedCalls: request.expectedCalls,
      peerSentinels: isConcurrency ? [] : request.peerSentinels,
    }).failureClass;
  const events: NormalizedEvent[] =
    observation.events.length > 0
      ? observation.events
      : [
          {
            type: 'error',
            atMs: 0,
            failureClass: resolvedClass ?? 'harness_failure',
          },
        ];
  return {
    case_id: request.testCase.id,
    pair_index: request.pairIndex,
    lane: request.lane,
    sentinel: request.sentinel,
    prompt_hash: requestHashForCase(request.testCase),
    injection_manifest: request.testCase.injectionManifest,
    stream_mode: request.testCase.streamModes[request.lane],
    events,
    trace_join: request.lane === 'yorha' ? sample.traceJoin : null,
    child_report: sample.childReport,
    canonical_tool_calls: observation.calls
      .filter((call) => call.valid && ['echo_value', 'lookup_code'].includes(call.name))
      .map((call, callIndex) => ({
        call_index: callIndex,
        name: call.name as 'echo_value' | 'lookup_code',
        executed: observation.executions.some(
          (execution) =>
            execution.callId === call.callId && execution.name === call.name && !execution.isError,
        ),
      })),
    metrics: finalizeMetrics(request.testCase, deriveTrialMetrics(events, sample.durationMs)),
    passed: resolvedClass === null,
    failure_class: resolvedClass,
    owning_layer: resolvedClass === null ? null : trialOwningLayer(request.testCase, resolvedClass),
    upstream_runs: sample.upstreamRuns,
  };
}
