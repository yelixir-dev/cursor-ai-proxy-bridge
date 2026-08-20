import type { BenchmarkCase, BenchmarkLane, CanonicalCaseId } from './types.js';
import type { ExpectedToolCall } from './oracle.js';

export const BENCHMARK_PROFILES = {
  smoke: { warmupPairs: 1, samplePairs: 3 },
  ci: { warmupPairs: 1, samplePairs: 11 },
  strict: { warmupPairs: 2, samplePairs: 21 },
} as const;
export type BenchmarkProfile = keyof typeof BENCHMARK_PROFILES;

export interface PairScheduleEntry {
  caseId: CanonicalCaseId;
  pairIndex: number;
  phase: 'warmup' | 'measured';
  lanes: readonly BenchmarkLane[];
}

export interface ScheduleOptions {
  seed: number;
  profile: BenchmarkProfile;
  cases: readonly BenchmarkCase[];
}

function shuffledCaseOrder(caseIds: readonly CanonicalCaseId[], seed: number): CanonicalCaseId[] {
  const order = [...caseIds];
  let state = (seed ^ 0x9e3779b9) >>> 0;
  const next = (): number => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state;
  };
  for (let index = order.length - 1; index > 0; index -= 1) {
    const swap = next() % (index + 1);
    [order[index], order[swap]] = [order[swap], order[index]];
  }
  return order;
}

export function buildPairSchedule(options: ScheduleOptions): PairScheduleEntry[] {
  const { warmupPairs, samplePairs } = BENCHMARK_PROFILES[options.profile];
  const byId = new Map(options.cases.map((testCase) => [testCase.id, testCase]));
  const entries: PairScheduleEntry[] = [];
  for (const caseId of shuffledCaseOrder(
    options.cases.map((testCase) => testCase.id),
    options.seed,
  )) {
    const testCase = byId.get(caseId);
    if (testCase === undefined) throw new RangeError('scheduled case is missing from case map');
    const lanes: readonly BenchmarkLane[] =
      testCase.kind === 'malformed' ? ['yorha'] : ['native', 'yorha'];
    for (let pairIndex = 0; pairIndex < warmupPairs + samplePairs; pairIndex += 1) {
      entries.push({
        caseId,
        pairIndex,
        phase: pairIndex < warmupPairs ? 'warmup' : 'measured',
        lanes: pairIndex % 2 === 0 ? lanes : [...lanes].reverse(),
      });
    }
  }
  return entries;
}

export function isMeasuredTrialFactory(
  schedule: readonly PairScheduleEntry[],
): (trial: { case_id: CanonicalCaseId; pair_index: number }) => boolean {
  const measuredKeys = new Set(
    schedule
      .filter((entry) => entry.phase === 'measured')
      .map((entry) => `${entry.caseId}\u0000${entry.pairIndex}`),
  );
  return (trial) => measuredKeys.has(`${trial.case_id}\u0000${trial.pair_index}`);
}

export function buildTrialPrompt(testCase: BenchmarkCase, sentinel: string): string {
  switch (testCase.request.operation) {
    case 'text_long':
      return `Write two short sentences about deterministic benchmarks, then end with exactly this token: ${sentinel}`;
    case 'tool_parallel':
      return `Call the echo_value tool twice in the same turn with arguments exactly {"value":"${sentinel}"} and {"value":"${sentinel}_SECOND"}, then reply with exactly: DONE`;
    case 'tool_sequential':
      return `Call the lookup_code tool once with arguments exactly {"key":"ALPHA"}, then reply with exactly the returned code followed by this token: ${sentinel}`;
    case 'tool_history':
      return `Call the lookup_code tool once with arguments exactly {"key":"BETA"}, then using only the tool result in your context reply with exactly the returned code followed by this token: ${sentinel}`;
    case 'tool_single':
    case 'tool_parallel_cap':
    case 'tool_required':
    case 'tool_forced':
    case 'tool_schema_recovery':
    case 'cancel_mid_tool':
      return `Call the echo_value tool once with arguments exactly {"value":"${sentinel}"}, then reply with exactly: DONE`;
    default:
      return `Reply with exactly this token and nothing else: ${sentinel}`;
  }
}

export function expectedCallsFor(testCase: BenchmarkCase, sentinel: string): ExpectedToolCall[] {
  switch (testCase.request.operation) {
    case 'tool_parallel':
      return [
        { name: 'echo_value', arguments: { value: sentinel } },
        { name: 'echo_value', arguments: { value: `${sentinel}_SECOND` } },
      ];
    case 'tool_sequential':
      return [{ name: 'lookup_code', arguments: { key: 'ALPHA' } }];
    case 'tool_history':
      return [{ name: 'lookup_code', arguments: { key: 'BETA' } }];
    case 'tool_single':
    case 'tool_parallel_cap':
    case 'tool_required':
    case 'tool_forced':
    case 'tool_schema_recovery':
    case 'cancel_mid_tool':
      return [{ name: 'echo_value', arguments: { value: sentinel } }];
    default:
      return [];
  }
}
