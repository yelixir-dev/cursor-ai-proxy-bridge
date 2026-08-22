import { describe, expect, it, vi } from 'vitest';
import { StickyRunStore, type HeldRun } from '../src/backend/cursor-api/sticky-run-store.js';

function held(key: string): HeldRun {
  return {
    key,
    resume: vi.fn(),
    release: vi.fn(),
  };
}

describe('cursor-api sticky Run result matching', () => {
  it('matches only the trailing tool-result group from accumulated history', () => {
    const store = new StickyRunStore();
    const run = held('call-b');
    store.park(run);

    const taken = store.take({
      messages: [
        { role: 'user', content: 'start' },
        { role: 'assistant', content: '', tool_calls: [] },
        { role: 'tool', tool_call_id: 'call-a', content: 'result-A' },
        { role: 'assistant', content: '', tool_calls: [] },
        { role: 'tool', tool_call_id: 'call-b', content: 'result-B' },
      ],
    });

    expect(taken).toBe(run);
    expect(store.size()).toBe(0);
  });

  it('does not consume a held Run when the request ends in a non-tool message', () => {
    const store = new StickyRunStore();
    const run = held('call-a');
    store.park(run);

    expect(
      store.take({
        messages: [
          { role: 'user', content: 'start' },
          { role: 'tool', tool_call_id: 'call-a', content: 'result-A' },
          { role: 'user', content: 'new turn' },
        ],
      }),
    ).toBeUndefined();
    expect(store.size()).toBe(1);
  });
});
