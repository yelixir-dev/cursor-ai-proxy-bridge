import { createHash } from 'node:crypto';
import type {
  BenchmarkCase,
  BenchmarkLane,
  CanonicalCaseId,
  CaseKind,
  CaseOracle,
  MetricName,
  StreamMode,
  ToolChoiceMode,
} from './types.js';

export { CANONICAL_CASE_IDS } from './types.js';

const TEXT_NULLS: MetricName[] = [
  'tool_decision_ms',
  'first_complete_call_ms',
  'all_complete_calls_ms',
  'tool_execution_ms',
  'cancellation_ms',
];
const TOOL_NULLS: MetricName[] = ['first_semantic_ms', 'cancellation_ms'];
const ERROR_NULLS: MetricName[] = [
  'first_semantic_ms',
  'tool_decision_ms',
  'first_complete_call_ms',
  'all_complete_calls_ms',
  'tool_execution_ms',
  'cancellation_ms',
];
const CANCEL_TEXT_NULLS: MetricName[] = [
  'first_semantic_ms',
  'tool_decision_ms',
  'first_complete_call_ms',
  'all_complete_calls_ms',
  'tool_execution_ms',
];
const CANCEL_TOOL_NULLS: MetricName[] = [
  'first_semantic_ms',
  'first_complete_call_ms',
  'all_complete_calls_ms',
  'tool_execution_ms',
];

interface CaseOptions {
  kind?: CaseKind;
  stream?: boolean;
  modes?: Record<BenchmarkLane, StreamMode>;
  tools?: string[];
  choice?: ToolChoiceMode;
  forcedTool?: string;
  parallel?: boolean;
  turns?: number;
  malformed?: string;
  nullMetrics?: MetricName[];
  oracle: CaseOracle;
}

function benchmarkCase(
  id: CanonicalCaseId,
  operation: string,
  options: CaseOptions,
): BenchmarkCase {
  const stream = options.stream ?? true;
  return {
    id,
    kind: options.kind ?? 'tool',
    streamModes:
      options.modes ??
      (stream
        ? { native: 'incremental', yorha: 'incremental' }
        : { native: 'nonstream', yorha: 'nonstream' }),
    nullMetrics: [...(options.nullMetrics ?? TOOL_NULLS)],
    request: {
      operation,
      stream,
      tools: [...(options.tools ?? [])],
      toolChoice: options.choice ?? 'auto',
      forcedTool: options.forcedTool ?? null,
      parallelToolCalls: options.parallel ?? null,
      turns: options.turns ?? 1,
      malformedVariant: options.malformed ?? null,
    },
    injectionManifest: [],
    oracle: options.oracle,
  };
}

const textOracle: CaseOracle = { kind: 'text', exactSentinel: true };
const httpErrorOracle: CaseOracle = { kind: 'http_error', status: 400, upstreamRuns: 0 };
const echoSingle: CaseOracle = {
  kind: 'tools',
  names: ['echo_value'],
  ordering: 'ordered',
  finalSentinel: false,
};
const DEFINITIONS: BenchmarkCase[] = [
  benchmarkCase('text_sentinel_stream', 'text_exact', {
    kind: 'text',
    nullMetrics: TEXT_NULLS,
    oracle: textOracle,
  }),
  benchmarkCase('text_sentinel_nostream', 'text_exact', {
    kind: 'text',
    stream: false,
    nullMetrics: TEXT_NULLS,
    oracle: textOracle,
  }),
  benchmarkCase('text_long_stream', 'text_long', {
    kind: 'text',
    nullMetrics: TEXT_NULLS,
    oracle: textOracle,
  }),
  benchmarkCase('tool_auto_single', 'tool_single', {
    tools: ['echo_value'],
    oracle: echoSingle,
  }),
  benchmarkCase('tool_parallel_two', 'tool_parallel', {
    tools: ['echo_value'],
    oracle: {
      kind: 'tools',
      names: ['echo_value', 'echo_value'],
      ordering: 'multiset',
      finalSentinel: false,
    },
  }),
  benchmarkCase('tool_sequential_two_round', 'tool_sequential', {
    tools: ['lookup_code'],
    turns: 2,
    nullMetrics: ['cancellation_ms'],
    oracle: { kind: 'tools', names: ['lookup_code'], ordering: 'ordered', finalSentinel: true },
  }),
  benchmarkCase('tool_history_replay', 'tool_history', {
    tools: ['lookup_code'],
    turns: 2,
    nullMetrics: ['cancellation_ms'],
    oracle: { kind: 'tools', names: ['lookup_code'], ordering: 'ordered', finalSentinel: true },
  }),
  benchmarkCase('tool_parallel_false_cap', 'tool_parallel_cap', {
    tools: ['echo_value'],
    choice: 'required',
    parallel: false,
    oracle: echoSingle,
  }),
  benchmarkCase('toolChoice_none', 'tool_none', {
    kind: 'text',
    tools: ['echo_value'],
    choice: 'none',
    nullMetrics: TEXT_NULLS,
    oracle: textOracle,
  }),
  benchmarkCase('toolChoice_required', 'tool_required', {
    tools: ['echo_value'],
    choice: 'required',
    modes: { native: 'incremental', yorha: 'buffered' },
    oracle: echoSingle,
  }),
  benchmarkCase('toolChoice_forced', 'tool_forced', {
    tools: ['echo_value'],
    choice: 'forced',
    forcedTool: 'echo_value',
    modes: { native: 'incremental', yorha: 'buffered' },
    oracle: echoSingle,
  }),
  benchmarkCase('tool_schema_recovery', 'tool_schema_recovery', {
    tools: ['echo_value'],
    choice: 'required',
    modes: { native: 'incremental', yorha: 'buffered' },
    oracle: echoSingle,
  }),
  ...(
    [
      ['malformed_unknown_forced_name', 'unknown_forced_name'],
      ['malformed_required_without_tools', 'required_without_tools'],
      ['malformed_duplicate_tool_names', 'duplicate_tool_names'],
      ['malformed_orphan_tool_call_id', 'orphan_tool_call_id'],
      ['malformed_duplicate_tool_call_ids', 'duplicate_tool_call_ids'],
      ['malformed_json', 'malformed_json'],
    ] as const
  ).map(([id, malformed]) =>
    benchmarkCase(id, 'reject_client_input', {
      kind: 'malformed',
      stream: false,
      malformed,
      nullMetrics: ERROR_NULLS,
      oracle: httpErrorOracle,
    }),
  ),
  benchmarkCase('cancel_after_first_event', 'cancel_after_first_event', {
    kind: 'cancellation',
    nullMetrics: CANCEL_TEXT_NULLS,
    oracle: { kind: 'cancellation', after: 'first_event' },
  }),
  benchmarkCase('cancel_mid_tool', 'cancel_mid_tool', {
    kind: 'cancellation',
    tools: ['echo_value'],
    nullMetrics: CANCEL_TOOL_NULLS,
    oracle: { kind: 'cancellation', after: 'tool_decision' },
  }),
  benchmarkCase('client_parallel_two', 'client_parallel', {
    kind: 'concurrency',
    nullMetrics: TEXT_NULLS,
    oracle: { kind: 'concurrency', isolatedSentinels: 2 },
  }),
  benchmarkCase('cold_boot_text', 'cold_boot_text', {
    kind: 'cold_boot',
    nullMetrics: TEXT_NULLS,
    oracle: textOracle,
  }),
];

export function createCanonicalCases(): BenchmarkCase[] {
  return structuredClone(DEFINITIONS);
}

export function sentinelFor(
  case_id: CanonicalCaseId,
  suiteSeed: number,
  pair_index: number,
  lane: BenchmarkLane,
): string {
  const digest = createHash('sha256')
    .update(`${case_id}\u0000${suiteSeed}\u0000${pair_index}\u0000${lane}`)
    .digest('hex')
    .slice(0, 12)
    .toUpperCase();
  return `BENCH_${case_id.toUpperCase()}_${lane.toUpperCase()}_${digest}`;
}

export function requestHashForCase(testCase: BenchmarkCase): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        request: testCase.request,
        injectionManifest: testCase.injectionManifest,
      }),
    )
    .digest('hex');
}
