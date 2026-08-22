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
      let failure: unknown;
      void completion.then(
        () => {
          outcome = 'resolved';
        },
        (error: unknown) => {
          failure = error;
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
      expect(failure).toMatchObject({
        code: 'ERR_CURSOR_RUN_TIMEOUT',
        runRequestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        diagnostics: {
          lastInteractionCase: null,
          lastInteractionAgoMs: 300_000,
          outputBytes: 0,
          sawTurnEnded: false,
          sawTrailer: false,
          transport: {},
        },
      });
      expect(transport.opened).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries one timed-out Run when opted in and no semantic output was delivered', async () => {
    vi.useFakeTimers();
    try {
      // Given: the first Run stalls before visible output and the replacement
      // Run completes normally.
      const transport = new ScriptedTransport((stream) => {
        stream.emit('response', { ':status': 200 });
        if (transport.opened.length !== 2) return;
        stream.emit(
          'data',
          Buffer.concat([
            update('textDelta', { text: 'recovered' }),
            update('turnEnded', { inputTokens: 1, outputTokens: 1 }),
            trailer(),
          ]),
        );
      });
      const completion = collect(
        backend(transport, undefined, {
          CURSOR_BRIDGE_CURSOR_TIMEOUT_MS: '50',
          CURSOR_BRIDGE_RUN_IDLE_MS: '1000',
          CURSOR_BRIDGE_RETRY_RUN_TIMEOUT: '1',
        }),
        { model: 'composer-2.5', messages: [{ role: 'user', content: 'work' }] },
      ).then(
        (events) => ({ kind: 'success' as const, events }),
        (error: unknown) => ({ kind: 'error' as const, error }),
      );
      await transport.firstRun;

      // When: the first Run reaches its overall timeout.
      await vi.advanceTimersByTimeAsync(50);
      const result = await completion;

      // Then: one replacement Run succeeds on the same requested model.
      expect(result.kind).toBe('success');
      if (result.kind === 'error') throw result.error;
      expect(transport.opened).toHaveLength(2);
      expect(result.events).toContainEqual({ type: 'content', text: 'recovered' });
      expect(result.events.at(-1)?.type).toBe('done');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry a timed-out Run after semantic output was delivered', async () => {
    vi.useFakeTimers();
    try {
      // Given: the Run emits client-visible content and then stalls.
      const transport = new ScriptedTransport((stream) => {
        stream.emit('response', { ':status': 200 });
        stream.emit('data', update('textDelta', { text: 'partial' }));
      });
      const completion = collect(
        backend(transport, undefined, {
          CURSOR_BRIDGE_CURSOR_TIMEOUT_MS: '50',
          CURSOR_BRIDGE_RUN_IDLE_MS: '1000',
          CURSOR_BRIDGE_RETRY_RUN_TIMEOUT: '1',
        }),
        { model: 'composer-2.5', messages: [{ role: 'user', content: 'work' }] },
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      await transport.firstRun;

      // When: the Run reaches the timeout after the content delta.
      await vi.advanceTimersByTimeAsync(50);
      const error = await completion;

      // Then: replay is refused because it could duplicate visible output.
      expect(error).toMatchObject({ code: 'ERR_CURSOR_RUN_TIMEOUT' });
      expect(transport.opened).toHaveLength(1);
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
