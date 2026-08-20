import { describe, expect, it } from 'vitest';
import { ToolHistoryValidationError, assertValidToolHistory } from '../src/backend/tool-history.js';
import type { ChatMessage, ToolCall } from '../src/backend/types.js';

function call(id: string, name = 'lookup'): ToolCall {
  return {
    id,
    type: 'function',
    function: { name, arguments: '{}' },
  };
}

function invalid(messages: ChatMessage[], expected: string): void {
  expect(() => assertValidToolHistory(messages)).toThrowError(ToolHistoryValidationError);
  expect(() => assertValidToolHistory(messages)).toThrowError(expected);
}

describe('tool history validation', () => {
  it('accepts contiguous matching results for every assistant call', () => {
    expect(() =>
      assertValidToolHistory([
        { role: 'user', content: 'look up both' },
        { role: 'assistant', content: '', tool_calls: [call('call_a'), call('call_b')] },
        { role: 'tool', content: 'A', tool_call_id: 'call_a' },
        { role: 'tool', content: 'B', tool_call_id: 'call_b' },
        { role: 'user', content: 'summarize' },
      ]),
    ).not.toThrow();
  });

  it('rejects a tool result without a matching preceding call', () => {
    invalid(
      [
        { role: 'user', content: 'start' },
        { role: 'tool', content: 'result', tool_call_id: 'missing' },
      ],
      'Unknown tool result id: missing',
    );
  });

  it('rejects duplicate tool call ids across history', () => {
    invalid(
      [
        { role: 'assistant', content: '', tool_calls: [call('same')] },
        { role: 'tool', content: 'first', tool_call_id: 'same' },
        { role: 'assistant', content: '', tool_calls: [call('same')] },
      ],
      'Duplicate tool call id: same',
    );
  });

  it('rejects tool calls attached to non-assistant messages', () => {
    invalid(
      [{ role: 'user', content: 'bad call', tool_calls: [call('call_user')] }],
      'Only assistant messages may contain tool calls',
    );
  });

  it('rejects an assistant call not followed by all matching results', () => {
    invalid(
      [
        { role: 'assistant', content: '', tool_calls: [call('call_a'), call('call_b')] },
        { role: 'tool', content: 'A', tool_call_id: 'call_a' },
      ],
      'Every assistant tool call must have a matching tool result',
    );
  });

  it('rejects an intervening non-tool message before pending results', () => {
    invalid(
      [
        { role: 'assistant', content: '', tool_calls: [call('call_a')] },
        { role: 'user', content: 'too soon' },
      ],
      'Every assistant tool call must be followed by its matching tool result',
    );
  });

  it('rejects a second tool result for an already answered call', () => {
    invalid(
      [
        { role: 'user', content: 'start' },
        { role: 'assistant', content: '', tool_calls: [call('call_dup')] },
        { role: 'tool', content: 'first', tool_call_id: 'call_dup' },
        { role: 'tool', content: 'second', tool_call_id: 'call_dup' },
      ],
      'Unknown tool result id: call_dup',
    );
  });
});
