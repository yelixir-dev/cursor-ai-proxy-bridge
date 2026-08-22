import { describe, expect, it, vi } from 'vitest';
import type { ChatCompletionRequest } from '../src/backend/types.js';
import {
  backend,
  collect,
  parallelToolRequest,
  ScriptedTransport,
  trailer,
  update,
} from './support/cursor-api-scripted.js';

describe('cursor-api interaction idle watchdog', () => {
  it('allows a 300-second run by default while the idle watchdog stays independent', async () => {
    vi.useFakeTimers();
    try {
      // Given: an active upstream run with the idle watchdog configured above
      // the overall ceiling so only the default run timeout can settle it.
      const transport = new ScriptedTransport((stream) => {
        stream.emit('response', { ':status': 200 });
      });
      const completion = collect(
        backend(transport, undefined, { CURSOR_BRIDGE_RUN_IDLE_MS: '600000' }),
        { model: 'composer-2.5', messages: [{ role: 'user', content: 'work' }] },
      );
      let outcome = 'pending';
      void completion.then(
        () => {
          outcome = 'resolved';
        },
        (error: unknown) => {
          outcome = error instanceof Error ? error.message : String(error);
        },
      );
      await transport.firstRun;

      // When: the old 120-second ceiling passes.
      await vi.advanceTimersByTimeAsync(120_000);

      // Then: the run remains alive until the new 300-second ceiling.
      expect(outcome).toBe('pending');
      await vi.advanceTimersByTimeAsync(180_000);
      expect(outcome).toBe('Cursor API run timed out after 300000ms');
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails fast when the run produces no interaction frames at all', async () => {
    // Given: a required tool call the model cannot map to a declared tool —
    // upstream answers the Run open, then never sends any interaction update
    // (the KEY2 silent-stall signature).
    const request: ChatCompletionRequest = {
      ...parallelToolRequest(),
      tool_choice: 'required',
      messages: [{ role: 'user', content: 'Call get_seed.' }],
    };
    const transport = new ScriptedTransport((stream) => {
      stream.emit('response', { ':status': 200 });
    });

    // When/Then: the idle watchdog rejects the completion well before the
    // run timeout would fire.
    await expect(
      collect(backend(transport, undefined, { CURSOR_BRIDGE_RUN_IDLE_MS: '50' }), request),
    ).rejects.toThrow(/no model output/);
  });

  it('stays quiet while interaction frames keep flowing', async () => {
    // Given: a normal turn whose interaction frames arrive steadily.
    const transport = new ScriptedTransport((stream) => {
      stream.emit('response', { ':status': 200 });
      stream.emit(
        'data',
        Buffer.concat([
          update('thinkingDelta', { text: 'hmm' }),
          update('textDelta', { text: 'answer' }),
          update('turnEnded', { inputTokens: 1, outputTokens: 1 }),
          trailer(),
        ]),
      );
    });

    // When/Then: the completion settles normally, no watchdog error.
    const events = await collect(
      backend(transport, undefined, { CURSOR_BRIDGE_RUN_IDLE_MS: '50' }),
      { model: 'composer-2.5', messages: [{ role: 'user', content: 'hi' }] },
    );
    expect(events.at(-1)?.type).toBe('done');
  });
});
