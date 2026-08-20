import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { firstSemanticGrapheme, normalizeEvents, stableJson } from '../src/benchmark/normalize.js';
import { judgeOracle, type OracleInput } from '../src/benchmark/oracle.js';
import type { CaseOracle, NormalizedEvent } from '../src/benchmark/types.js';

const echoOracle: CaseOracle = {
  kind: 'tools',
  names: ['echo_value'],
  ordering: 'ordered',
  finalSentinel: false,
};
const parallelOracle: CaseOracle = {
  kind: 'tools',
  names: ['echo_value', 'echo_value'],
  ordering: 'multiset',
  finalSentinel: false,
};
const sequentialOracle: CaseOracle = {
  kind: 'tools',
  names: ['lookup_code', 'lookup_code'],
  ordering: 'ordered',
  finalSentinel: false,
};

const echoArgs = { z: 1, a: 2 };
const expectedEcho = [{ name: 'echo_value', arguments: { a: 2, z: 1 } }];

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function update(event: Record<string, unknown>, atMs: number) {
  return { type: 'message_update', atMs, assistantMessageEvent: event };
}

function execution(id: string, name: string, args: Record<string, unknown>, atMs: number) {
  return [
    { type: 'tool_execution_start', atMs, toolCallId: id, toolName: name, args },
    {
      type: 'tool_execution_end',
      atMs: atMs + 1,
      toolCallId: id,
      toolName: name,
      result: { ok: true },
      isError: false,
    },
  ];
}

function nativeIncremental(
  id: string,
  name: string,
  args: Record<string, unknown>,
  atMs: number,
  fragments: string[],
) {
  return [
    update({ type: 'toolcall_start', contentIndex: 0 }, atMs),
    ...fragments.map((delta, index) =>
      update({ type: 'toolcall_delta', contentIndex: 0, delta }, atMs + 1 + index),
    ),
    update(
      {
        type: 'toolcall_end',
        contentIndex: 0,
        toolCall: { type: 'toolCall', id, name, arguments: args },
      },
      atMs + 10,
    ),
    ...execution(id, name, args, atMs + 11),
  ];
}

function yorhaCompleted(
  id: string,
  name: string,
  argumentJson: string,
  atMs: number,
  parsed: Record<string, unknown>,
) {
  return [
    {
      type: 'message_end',
      atMs,
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id,
            type: 'function',
            function: { name, arguments: argumentJson },
          },
        ],
      },
    },
    ...execution(id, name, parsed, atMs + 1),
  ];
}

function closed(events: unknown[], terminalAt = 90): unknown[] {
  return [{ type: 'agent_start', atMs: 0 }, ...events, { type: 'agent_end', atMs: terminalAt }];
}

function judge(
  partial: Omit<OracleInput, 'oracle' | 'sentinel'> & Partial<OracleInput>,
): ReturnType<typeof judgeOracle> {
  return judgeOracle({
    oracle: echoOracle,
    sentinel: 'SENTINEL_OWN',
    expectedCalls: expectedEcho,
    ...partial,
  });
}

function completeCalls(events: readonly NormalizedEvent[]) {
  return events.filter((event) => event.type === 'complete_call');
}

describe('benchmark normalize and oracle', () => {
  it('treats the first Unicode letter/number grapheme as first semantic text', () => {
    const events = closed([
      { type: 'message_start', atMs: 1, message: { role: 'assistant', content: [] } },
      update({ type: 'thinking_delta', delta: 'plan A7' }, 2),
      update({ type: 'text_delta', delta: '  \n' }, 3),
      update(
        {
          type: 'text_delta',
          delta: '[TOOL_CALLS: [{"function":{"name":"echo_value","arguments":{"value":"no"}}}]]',
        },
        4,
      ),
      update(
        {
          type: 'text_delta',
          delta: '```json {"tool_calls":[{"function":{"name":"echo_value","arguments":{}}}]}```',
        },
        5,
      ),
      update({ type: 'text_delta', delta: '  e\u0301X' }, 6),
    ]);

    expect(firstSemanticGrapheme(events)).toBe('e\u0301');
    const text = normalizeEvents(events).filter((event) => event.type === 'text');
    expect(text.some((event) => event.atMs === 6)).toBe(true);
    expect(text.every((event) => event.atMs !== 2)).toBe(true);
  });

  it('normalizes native incremental and yorha completed object args to one stable call', () => {
    const native = closed(
      nativeIncremental('native_call', 'echo_value', echoArgs, 2, ['{"z":1,', '"a":2}']),
    );
    const yorha = closed(
      yorhaCompleted('yorha_call', 'echo_value', '{"a":2,"z":1}', 2, { a: 2, z: 1 }),
    );

    expect(stableJson({ b: 2, a: 1 })).toBe(stableJson({ a: 1, b: 2 }));
    expect(stableJson({ a: 1, b: 2 })).toBe('{"a":1,"b":2}');

    const nativeNorm = normalizeEvents(native);
    const yorhaNorm = normalizeEvents(yorha);
    const nativeCall = completeCalls(nativeNorm)[0];
    const yorhaCall = completeCalls(yorhaNorm)[0];

    expect(nativeCall).toMatchObject({
      type: 'complete_call',
      name: 'echo_value',
      argumentsHash: sha256(stableJson(echoArgs)),
    });
    expect(yorhaCall).toMatchObject({
      type: 'complete_call',
      name: 'echo_value',
      argumentsHash: nativeCall?.argumentsHash,
    });
    expect(nativeCall?.callIdHash).not.toBe(yorhaCall?.callIdHash);
    expect(nativeNorm.filter((event) => event.type === 'tool_args_delta').length).toBe(2);
    expect(nativeNorm.map((event) => event.type)).toContain('tool_decision');
    expect(yorhaNorm.map((event) => event.type)).toContain('execution_end');

    const nativeVerdict = judge({ events: native });
    const yorhaVerdict = judge({ events: yorha });
    expect(nativeVerdict).toEqual(yorhaVerdict);
    expect(nativeVerdict.passed).toBe(true);
    expect(nativeVerdict.failureClass).toBeNull();
    expect(nativeVerdict.receipt.passed).toBe(true);
    expect(nativeVerdict.receipt.toolKeys).toEqual([`echo_value:${nativeCall?.argumentsHash}`]);
  });

  it('compares sequential calls in order and parallel calls as a multiset', () => {
    const swappedLookups = closed([
      ...nativeIncremental('seq_b', 'lookup_code', { key: 'K2' }, 2, ['{"key":"K2"}']),
      ...nativeIncremental('seq_a', 'lookup_code', { key: 'K1' }, 20, ['{"key":"K1"}']),
    ]);
    const swappedEchoes = closed([
      ...yorhaCompleted('par_b', 'echo_value', '{"value":"B"}', 2, { value: 'B' }),
      ...yorhaCompleted('par_a', 'echo_value', '{"value":"A"}', 20, { value: 'A' }),
    ]);
    const expectedLookups = [
      { name: 'lookup_code', arguments: { key: 'K1' } },
      { name: 'lookup_code', arguments: { key: 'K2' } },
    ];
    const expectedEchoes = [
      { name: 'echo_value', arguments: { value: 'A' } },
      { name: 'echo_value', arguments: { value: 'B' } },
    ];

    const sequential = judge({
      events: swappedLookups,
      oracle: sequentialOracle,
      expectedCalls: expectedLookups,
    });
    const parallel = judge({
      events: swappedEchoes,
      oracle: parallelOracle,
      expectedCalls: expectedEchoes,
    });

    expect(
      completeCalls(normalizeEvents(swappedLookups)).map((event) => event.argumentsHash),
    ).toEqual([sha256(stableJson({ key: 'K2' })), sha256(stableJson({ key: 'K1' }))]);
    expect(sequential.failureClass).toBe('tool_order_mismatch');
    expect(sequential.passed).toBe(false);
    expect(parallel.failureClass).toBeNull();
    expect(parallel.passed).toBe(true);
    expect(parallel.receipt.toolKeys).toHaveLength(2);
  });

  it('requires a per-trial oracle receipt and ignores generated call ids across lanes', () => {
    const native = closed(
      nativeIncremental('lane_native', 'echo_value', { value: 'R' }, 2, ['{"value":"R"}']),
    );
    const yorha = closed(
      yorhaCompleted('lane_yorha', 'echo_value', '{"value":"R"}', 2, { value: 'R' }),
    );
    const expected = [{ name: 'echo_value', arguments: { value: 'R' } }];

    const first = judge({ events: native, sentinel: 'TRIAL_ONE', expectedCalls: expected });
    const second = judge({ events: yorha, sentinel: 'TRIAL_TWO', expectedCalls: expected });
    expect(first.passed).toBe(true);
    expect(second.passed).toBe(true);
    expect(first.receipt.sentinel).toBe('TRIAL_ONE');
    expect(second.receipt.sentinel).toBe('TRIAL_TWO');
    expect(first.receipt.toolKeys).toEqual(second.receipt.toolKeys);
    expect(first.receipt).not.toBe(second.receipt);
  });

  it('requires each lane to replay its own emitted tool id exactly', () => {
    const events = closed(
      nativeIncremental('call_lane_1', 'lookup_code', { key: 'K' }, 2, ['{"key":"K"}']),
    );
    const expected = [{ name: 'lookup_code', arguments: { key: 'K' } }];
    const replayOracle: CaseOracle = {
      kind: 'tools',
      names: ['lookup_code'],
      ordering: 'ordered',
      finalSentinel: false,
    };

    expect(
      judge({
        events,
        oracle: replayOracle,
        expectedCalls: expected,
        historyReplay: { emitted: ['call_lane_1'], replayed: ['call_lane_1'] },
      }).failureClass,
    ).toBeNull();
    expect(
      judge({
        events,
        oracle: replayOracle,
        expectedCalls: expected,
        historyReplay: { emitted: ['call_lane_1'], replayed: ['call_other'] },
      }).failureClass,
    ).toBe('tool_id_replay_mismatch');
  });

  it('rejects hallucinated prose that claims a tool success without a receipt', () => {
    const events = closed([
      update(
        {
          type: 'text_delta',
          delta: 'I successfully called echo_value with value SECRET and the tool returned SECRET.',
        },
        2,
      ),
    ]);

    const verdict = judge({ events, expectedCalls: expectedEcho });
    expect(verdict.passed).toBe(false);
    expect(verdict.failureClass).toBe('hallucinated_tool');
    expect(verdict.receipt.failureClass).toBe('hallucinated_tool');
    expect(verdict.receipt.toolKeys).toEqual([]);
  });

  it('does not let a prior trial receipt satisfy a later prose-only trial', () => {
    const honest = closed(
      nativeIncremental('receipt_call', 'echo_value', { a: 2, z: 1 }, 2, ['{"a":2,"z":1}']),
    );
    const injected = closed([
      update({ type: 'text_delta', delta: 'echo_value already succeeded with the same args' }, 2),
    ]);

    const prior = judge({ events: honest, sentinel: 'TRIAL_A' });
    const later = judge({ events: injected, sentinel: 'TRIAL_B' });
    expect(prior.passed).toBe(true);
    expect(later.failureClass).toBe('hallucinated_tool');
    expect(later.receipt.sentinel).toBe('TRIAL_B');
  });

  it('flags substituted native built-ins instead of the expected oracle tool', () => {
    const events = closed(
      nativeIncremental('shell_1', 'Shell', { command: 'printf hi' }, 2, [
        '{"command":"printf hi"}',
      ]),
    );

    expect(judge({ events }).failureClass).toBe('substituted_builtin');
  });

  it('rejects schema-invalid completed calls and broken non-object args', () => {
    const arrayArgs = closed(
      yorhaCompleted('bad_array', 'echo_value', '["nope"]', 2, { value: 'x' }),
    );
    const broken = closed(
      yorhaCompleted('bad_json', 'echo_value', '{"unterminated":', 2, { value: 'x' }),
    );

    expect(judge({ events: arrayArgs }).failureClass).toBe('invalid_tool_args');
    expect(judge({ events: broken }).failureClass).toBe('invalid_tool_args');
    expect(completeCalls(normalizeEvents(arrayArgs))).toEqual([]);
    expect(normalizeEvents(broken).some((event) => event.type === 'error')).toBe(true);
  });

  it('flags duplicated oracle calls', () => {
    const events = closed([
      ...yorhaCompleted('dup_1', 'echo_value', '{"a":2,"z":1}', 2, { a: 2, z: 1 }),
      ...yorhaCompleted('dup_2', 'echo_value', '{"z":1,"a":2}', 20, { z: 1, a: 2 }),
    ]);

    expect(judge({ events }).failureClass).toBe('duplicate_tool_call');
  });

  it('flags a missing terminal event', () => {
    const events = [
      { type: 'agent_start', atMs: 0 },
      ...nativeIncremental('term_1', 'echo_value', { a: 2, z: 1 }, 2, ['{"a":2,"z":1}']),
    ];

    expect(judge({ events }).failureClass).toBe('missing_terminal');
  });

  it('classifies late events after abort without dropping them', () => {
    const events = [
      { type: 'agent_start', atMs: 0 },
      { type: 'aborted', atMs: 4 },
      update({ type: 'text_delta', delta: 'late leak' }, 5),
      { type: 'agent_end', atMs: 6 },
    ];

    const normalized = normalizeEvents(events);
    expect(
      normalized.some(
        (event) => event.type === 'error' && event.failureClass === 'late_after_abort',
      ),
    ).toBe(true);
    expect(normalized.some((event) => event.type === 'text' && event.atMs === 5)).toBe(true);
    expect(
      judge({ events, oracle: { kind: 'text', exactSentinel: false }, expectedCalls: [] })
        .failureClass,
    ).toBe('late_after_abort');
  });

  it('detects concurrent sentinel crosstalk', () => {
    const events = closed([
      update({ type: 'text_delta', delta: 'own SENTINEL_OWN and leaked SENTINEL_PEER' }, 2),
    ]);

    const verdict = judge({
      events,
      oracle: { kind: 'text', exactSentinel: true },
      expectedCalls: [],
      peerSentinels: ['SENTINEL_PEER'],
    });
    expect(verdict.failureClass).toBe('crosstalk');
    expect(verdict.receipt.failureClass).toBe('crosstalk');
  });
});
