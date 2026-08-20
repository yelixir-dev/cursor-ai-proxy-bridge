import { type EventObservation, observeEvents, sha256Hex, stableJson } from './normalize.js';
import type { CaseOracle, FailureClass } from './types.js';

const ORACLE_TOOLS = new Set(['echo_value', 'lookup_code']);
const NATIVE_BUILTINS = new Set([
  'Shell',
  'Read',
  'Grep',
  'LS',
  'Delete',
  'Write',
  'StrReplace',
  'Diagnostics',
  'todo',
  'connect_scm',
  'read_file',
  'write_file',
  'edit_file',
  'codebase_search',
]);

export interface ExpectedToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface OracleInput {
  events: readonly unknown[];
  oracle: CaseOracle;
  sentinel: string;
  expectedCalls?: readonly ExpectedToolCall[];
  historyReplay?: { emitted: readonly string[]; replayed: readonly string[] };
  peerSentinels?: readonly string[];
}

export interface OracleReceipt {
  sentinel: string;
  passed: boolean;
  failureClass: FailureClass | null;
  toolKeys: string[];
}

export interface OracleVerdict {
  passed: boolean;
  failureClass: FailureClass | null;
  receipt: OracleReceipt;
}

function countKeys(keys: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return counts;
}

function sameMultiset(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const other = countKeys(right);
  for (const [key, count] of countKeys(left)) {
    if (other.get(key) !== count) return false;
  }
  return true;
}

function errorClass(observation: EventObservation, failureClass: FailureClass): boolean {
  return observation.events.some(
    (event) => event.type === 'error' && event.failureClass === failureClass,
  );
}

function toolKey(name: string, argumentsHash: string): string {
  return `${name}:${argumentsHash}`;
}

function classify(observation: EventObservation, input: OracleInput): FailureClass | null {
  if (errorClass(observation, 'late_after_abort')) return 'late_after_abort';
  if (
    errorClass(observation, 'crosstalk') ||
    (input.peerSentinels ?? []).some((sentinel) => observation.visibleText.includes(sentinel))
  ) {
    return 'crosstalk';
  }
  if (
    observation.calls.some((call) => !call.valid) ||
    errorClass(observation, 'invalid_tool_args')
  ) {
    return 'invalid_tool_args';
  }

  const actual = observation.calls.filter((call) => call.valid);
  const expected = input.expectedCalls ?? [];
  const expectedNames =
    expected.length > 0
      ? expected.map((call) => call.name)
      : input.oracle.kind === 'tools'
        ? input.oracle.names
        : [];

  if (actual.some((call) => NATIVE_BUILTINS.has(call.name) && !expectedNames.includes(call.name))) {
    return 'substituted_builtin';
  }

  const received = new Set(
    observation.executions.filter((item) => !item.isError).map((item) => item.name),
  );
  const claimed = [...ORACLE_TOOLS].some((name) => {
    const used =
      actual.some((call) => call.name === name) || observation.visibleText.includes(name);
    return used && !received.has(name);
  });
  if (claimed) return 'hallucinated_tool';

  if (input.historyReplay) {
    const { emitted, replayed } = input.historyReplay;
    if (emitted.length !== replayed.length || emitted.some((id, index) => id !== replayed[index])) {
      return 'tool_id_replay_mismatch';
    }
  }

  if (!observation.events.some((event) => event.type === 'terminal')) return 'missing_terminal';

  switch (input.oracle.kind) {
    case 'cancellation':
      if (!observation.events.some((event) => event.type === 'aborted')) return 'cancel_failed';
      if (
        input.oracle.after === 'tool_decision' &&
        !observation.events.some((event) => event.type === 'tool_decision')
      ) {
        return 'cancel_failed';
      }
      return null;
    case 'text':
      if (actual.length > 0) return 'unexpected_tool';
      if (input.oracle.exactSentinel && !observation.visibleText.includes(input.sentinel)) {
        return 'sentinel_mismatch';
      }
      return null;
    case 'concurrency':
    case 'http_error':
      return null;
    case 'tools':
      break;
    default: {
      const _exhaustive: never = input.oracle;
      return _exhaustive;
    }
  }

  if (actual.length > expectedNames.length) {
    const expectedKeys = expected.map((call) =>
      toolKey(call.name, sha256Hex(stableJson(call.arguments))),
    );
    const actualKeys = actual.map((call) => toolKey(call.name, call.argumentsHash));
    const [got, want] =
      expected.length > 0
        ? [actualKeys, expectedKeys]
        : [actual.map((call) => call.name), expectedNames];
    const wantCounts = countKeys(want);
    if (
      [...countKeys(got)].some(
        ([key, count]) => count > (wantCounts.get(key) ?? 0) && (wantCounts.get(key) ?? 0) > 0,
      )
    ) {
      return 'duplicate_tool_call';
    }
    if (actual.some((call) => !expectedNames.includes(call.name))) return 'unexpected_tool';
    return 'duplicate_tool_call';
  }
  if (actual.length < expectedNames.length) return 'missing_tool_call';

  if (expected.length > 0) {
    const expectedKeys = expected.map((call) =>
      toolKey(call.name, sha256Hex(stableJson(call.arguments))),
    );
    const actualKeys = actual.map((call) => toolKey(call.name, call.argumentsHash));
    if (input.oracle.ordering === 'ordered') {
      if (actualKeys.join('\0') !== expectedKeys.join('\0')) {
        return sameMultiset(actualKeys, expectedKeys) ? 'tool_order_mismatch' : 'invalid_tool_args';
      }
    } else if (!sameMultiset(actualKeys, expectedKeys)) {
      return 'invalid_tool_args';
    }
  } else if (input.oracle.ordering === 'ordered') {
    const names = actual.map((call) => call.name);
    if (names.join('\0') !== expectedNames.join('\0')) {
      return sameMultiset(names, expectedNames) ? 'tool_order_mismatch' : 'missing_tool_call';
    }
  } else if (
    !sameMultiset(
      actual.map((call) => call.name),
      expectedNames,
    )
  ) {
    return 'missing_tool_call';
  }

  if (input.oracle.finalSentinel && !observation.visibleText.includes(input.sentinel)) {
    return 'sentinel_mismatch';
  }
  return null;
}

export function judgeOracle(input: OracleInput): OracleVerdict {
  const observation = observeEvents(input.events, {
    sentinel: input.sentinel,
    peerSentinels: input.peerSentinels,
  });
  const failureClass = classify(observation, input);
  const receipt: OracleReceipt = {
    sentinel: input.sentinel,
    passed: failureClass === null,
    failureClass,
    toolKeys: observation.calls
      .filter((call) => call.valid)
      .map((call) => toolKey(call.name, call.argumentsHash)),
  };
  return { passed: receipt.passed, failureClass, receipt };
}
