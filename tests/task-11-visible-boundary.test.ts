import { describe, expect, it } from 'vitest';
import { isClientVisibleRunEvent } from '../src/backend/cursor-api/visible-lifecycle.js';
import type { CompletionStreamEvent } from '../src/backend/types.js';

const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

describe('task 11 semantic replay boundary', () => {
  it.each<CompletionStreamEvent>([
    { type: 'content', text: 'visible' },
    { type: 'tool_call_start', index: 0, id: 'call-1', name: 'echo_value' },
    { type: 'tool_call_arguments_delta', index: 0, id: 'call-1', delta: '{}' },
    {
      type: 'tool_call_complete',
      index: 0,
      call: {
        id: 'call-1',
        type: 'function',
        function: { name: 'echo_value', arguments: '{}' },
      },
    },
  ])('classifies $type as client-visible and therefore non-retryable', (event) => {
    expect(isClientVisibleRunEvent(event)).toBe(true);
  });

  it.each<CompletionStreamEvent>([
    { type: 'thinking', text: 'hidden' },
    { type: 'done', usage, usage_source: 'unknown', is_error: false },
  ])('does not classify $type as a semantic replay boundary', (event) => {
    expect(isClientVisibleRunEvent(event)).toBe(false);
  });
});
