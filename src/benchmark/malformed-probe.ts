import { performance } from 'node:perf_hooks';
import { BRIDGE_API_KEY, type BridgeHandle } from './bridge-process.js';
import { emptyTrialChild } from './child-trace.js';
import type { LaneTrialRequest, LaneTrialSample } from './trial-record.js';
import type { FailureClass } from './types.js';

export interface MalformedProbeContext {
  readonly bridge: BridgeHandle;
}

export class MalformedProbeError extends Error {
  readonly name = 'MalformedProbeError';
  readonly code = 'response_body_read_failed';

  constructor(cause: unknown) {
    super('malformed probe response body could not be read', { cause });
  }
}

function malformedRequestBody(variant: string, sentinel: string): string {
  const tool = {
    type: 'function',
    function: { name: 'echo_value', description: 'benchmark probe' },
  };
  const userMessage = { role: 'user', content: `probe ${sentinel}` };
  const base = { model: 'composer-2.5', messages: [userMessage] };
  switch (variant) {
    case 'unknown_forced_name':
      return JSON.stringify({
        ...base,
        tools: [tool],
        tool_choice: { type: 'function', function: { name: 'missing_tool' } },
      });
    case 'required_without_tools':
      return JSON.stringify({ ...base, tool_choice: 'required' });
    case 'duplicate_tool_names':
      return JSON.stringify({ ...base, tools: [tool, tool] });
    case 'orphan_tool_call_id':
      return JSON.stringify({
        ...base,
        messages: [...base.messages, { role: 'tool', tool_call_id: 'call_orphan', content: 'x' }],
      });
    case 'duplicate_tool_call_ids':
      return JSON.stringify({
        ...base,
        messages: [
          ...base.messages,
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_dup',
                type: 'function',
                function: { name: 'echo_value', arguments: '{}' },
              },
              {
                id: 'call_dup',
                type: 'function',
                function: { name: 'echo_value', arguments: '{}' },
              },
            ],
          },
        ],
      });
    default:
      return '{"model": "composer-2.5", "messages": [';
  }
}

export async function malformedProbe(
  context: MalformedProbeContext,
  request: LaneTrialRequest,
): Promise<LaneTrialSample> {
  const variant = request.testCase.request.malformedVariant ?? 'malformed_json';
  const traceScope = context.bridge.beginTraceScope();
  const started = performance.now();
  const response = await fetch(`${context.bridge.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${BRIDGE_API_KEY}`,
      'content-type': 'application/json',
    },
    body: malformedRequestBody(variant, request.sentinel),
    signal: AbortSignal.timeout(30_000),
  });
  try {
    await response.arrayBuffer();
  } catch (cause) {
    await traceScope.finish();
    throw new MalformedProbeError(cause);
  }
  const traceJoin = await traceScope.finish();
  const upstreamRuns = traceJoin.attributed_run_count;
  const failureClass: FailureClass | null =
    response.status !== 400 || upstreamRuns > 0 ? 'invalid_request_accepted' : null;
  const elapsed = performance.now() - started;
  return {
    rawEvents: [
      { type: 'agent_start', atMs: 0 },
      { type: 'agent_end', atMs: elapsed },
    ],
    durationMs: elapsed,
    upstreamRuns,
    failureClass,
    promptHash: null,
    httpStatus: response.status,
    isolatedSentinels: null,
    traceJoin,
    childReport: emptyTrialChild(),
  };
}
