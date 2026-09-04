import { describe, expect, it, vi } from 'vitest';
import {
  captureContinuationContract,
  type HeldRun,
  stickyKey,
  StickyRunStore,
} from '../src/backend/cursor-api/sticky-run-store.js';
import type { ChatMessage } from '../src/backend/types.js';

function held(key: string, messages: ChatMessage[] = []): HeldRun {
  return {
    key,
    credentialId: 'test-credential',
    continuation: captureContinuationContract({ model: 'composer-2.5', messages }, false),
    resume: vi.fn(),
    release: vi.fn(),
  };
}

describe('cursor-api sticky Run result matching', () => {
  it('evicts the oldest held Run when the store reaches its capacity', () => {
    const store = new StickyRunStore(2);
    const first = held(stickyKey(['call-a']));
    const second = held(stickyKey(['call-b']));
    const third = held(stickyKey(['call-c']));

    store.park(first);
    store.park(second);
    store.park(third);

    expect(store.size()).toBe(2);
    expect(first.release).toHaveBeenCalledOnce();
    expect(second.release).not.toHaveBeenCalled();
    expect(third.release).not.toHaveBeenCalled();
  });

  it('keeps distinct tool-id sets separate when concatenated text is identical', () => {
    const store = new StickyRunStore();
    const first = held(stickyKey(['ab', 'c']));
    const second = held(stickyKey(['a', 'bc']));
    store.park(first);
    store.park(second);

    const taken = store.take(
      {
        model: 'composer-2.5',
        messages: [
          { role: 'tool', tool_call_id: 'ab', content: 'result-ab' },
          { role: 'tool', tool_call_id: 'c', content: 'result-c' },
        ],
      },
      false,
    );

    expect(stickyKey(['ab', 'c'])).not.toBe(stickyKey(['a', 'bc']));
    expect(taken).toBe(first);
    expect(store.size()).toBe(1);
    expect(second.release).not.toHaveBeenCalled();
  });

  it('matches only the trailing tool-result group from accumulated history', () => {
    const store = new StickyRunStore();
    const history: ChatMessage[] = [
      { role: 'user', content: 'start' },
      { role: 'assistant', content: '', tool_calls: [] },
      { role: 'tool', tool_call_id: 'call-a', content: 'result-A' },
      { role: 'assistant', content: '', tool_calls: [] },
    ];
    const run = held(stickyKey(['call-b']), history);
    store.park(run);

    const taken = store.take(
      {
        model: 'composer-2.5',
        messages: [...history, { role: 'tool', tool_call_id: 'call-b', content: 'result-B' }],
      },
      false,
    );

    expect(taken).toBe(run);
    expect(store.size()).toBe(0);
  });

  it('does not consume a held Run when the request ends in a non-tool message', () => {
    const store = new StickyRunStore();
    const run = held(stickyKey(['call-a']));
    store.park(run);

    expect(
      store.take(
        {
          model: 'composer-2.5',
          messages: [
            { role: 'user', content: 'start' },
            { role: 'tool', tool_call_id: 'call-a', content: 'result-A' },
            { role: 'user', content: 'new turn' },
          ],
        },
        false,
      ),
    ).toBeUndefined();
    expect(store.size()).toBe(1);
  });
});
