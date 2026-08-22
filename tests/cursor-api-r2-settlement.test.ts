import { describe, expect, it, vi } from 'vitest';
import type { ChatCompletionRequest } from '../src/backend/types.js';
import {
  backend,
  callBatch,
  collect,
  parallelToolRequest,
  ScriptedTransport,
  toolCall,
  trailer,
  update,
  wireToolName,
} from './support/cursor-api-scripted.js';

describe('cursor-api authoritative Run settlement', () => {
  it('rejects a terminal Run without content or tool calls', async () => {
    // Given: the upstream turn and Connect stream terminate without any
    // assistant-visible output.
    const transport = new ScriptedTransport((stream) => {
      stream.emit('response', { ':status': 200 });
      stream.emit(
        'data',
        Buffer.concat([update('turnEnded', { inputTokens: 3, outputTokens: 0 }), trailer()]),
      );
    });

    // When/Then: usage-only terminal metadata is not an empty success.
    await expect(
      collect(backend(transport), {
        model: 'composer-2.5',
        messages: [{ role: 'user', content: 'return visible output' }],
      }),
    ).rejects.toThrow('ended without content or tool calls');
  });

  it('rejects a terminal batch with an incomplete parallel sibling', async () => {
    // Given: A completes, but B has only started when the native turn and
    // Connect stream both terminate.
    const request = parallelToolRequest();
    const wireName = wireToolName(request);
    const transport = new ScriptedTransport((stream) => {
      stream.emit('response', { ':status': 200 });
      stream.emit(
        'data',
        Buffer.concat([
          callBatch(wireName, 'call-a', 'A'),
          update('toolCallStarted', {
            callId: 'envelope-b',
            toolCall: {
              tool: {
                case: 'mcpToolCall',
                value: { args: toolCall(wireName, 'call-b', '') },
              },
              toolCallId: 'call-b',
            },
          }),
          update('partialToolCall', {
            callId: 'envelope-b',
            argsTextDelta: '{"value":"B',
          }),
          update('turnEnded', { inputTokens: 3, outputTokens: 1 }),
          trailer(),
        ]),
      );
    });

    // When/Then: no successful done event can follow an incomplete call.
    await expect(collect(backend(transport), request)).rejects.toThrow(
      'ended with incomplete tool call',
    );
  });

  it('suppresses payloads after the authoritative trailer in the same chunk', async () => {
    // Given: malformed upstream data contains another payload after the
    // Connect end-stream trailer.
    const transport = new ScriptedTransport((stream) => {
      stream.emit('response', { ':status': 200 });
      stream.emit(
        'data',
        Buffer.concat([
          update('textDelta', { text: 'BEFORE' }),
          trailer(),
          update('textDelta', { text: 'AFTER' }),
          Buffer.alloc(3_000),
        ]),
      );
    });

    // When: the client consumes the completion.
    const completion = collect(
      backend(transport, undefined, { CURSOR_BRIDGE_MAX_OUTPUT_BYTES: '2048' }),
      {
        model: 'composer-2.5',
        messages: [{ role: 'user', content: 'return bounded text' }],
      },
    );
    const run = await transport.firstRun;
    const events = await completion;

    // Then: the first trailer cuts off later frames and closes the transport.
    expect(events.filter((event) => event.type === 'content')).toEqual([
      { type: 'content', text: 'BEFORE' },
    ]);
    expect(events.at(-1)?.type).toBe('done');
    expect(run.stream.closeCalls).toBe(1);
  });

  it.each([1, 3])(
    'retains a parallel call delivered after %i later data deliveries and settles at the trailer',
    async (deliveries) => {
      vi.useFakeTimers();
      try {
        // Given: call A completes first, then ongoing model traffic extends
        // the inactivity window before call B and the trailer arrive.
        const request = parallelToolRequest();
        const wireName = wireToolName(request);
        const transport = new ScriptedTransport((stream) => {
          stream.emit('response', { ':status': 200 });
          stream.emit('data', callBatch(wireName, 'call-a', 'A'));
          for (let index = 1; index <= deliveries; index += 1) {
            setTimeout(
              () => stream.emit('data', update('thinkingDelta', { text: `note-${index}` })),
              Math.floor((80 * index) / deliveries),
            );
          }
          setTimeout(() => {
            stream.emit('data', callBatch(wireName, 'call-b', 'B'));
            stream.emit('data', trailer());
          }, 150);
        });
        const completion = collect(
          backend(transport, undefined, { CURSOR_BRIDGE_STICKY_SETTLE_MS: '100' }),
          request,
        );
        await transport.firstRun;

        // When: all deterministic deliveries complete.
        await vi.advanceTimersByTimeAsync(200);
        const events = await completion;

        // Then: starts and deltas stay incremental, and the settled batch is exact.
        const toolEvents = events.filter(
          (event) => event.type === 'tool_call_start' || event.type === 'tool_call_arguments_delta',
        );
        expect(events[0]).toMatchObject({ type: 'tool_call_start' });
        if (events[0]?.type === 'tool_call_start') {
          expect(events[0].id).toMatch(/^call_[a-f0-9]{32}_0$/);
        }
        expect(toolEvents.map((event) => event.type)).toEqual([
          'tool_call_start',
          'tool_call_arguments_delta',
          'tool_call_start',
          'tool_call_arguments_delta',
        ]);
        const completed = events.filter((event) => event.type === 'tool_call_complete');
        expect(completed.map((event) => JSON.parse(event.call.function.arguments).value)).toEqual([
          'A',
          'B',
        ]);
        expect(new Set(completed.map((event) => event.call.id)).size).toBe(2);
        expect(events.at(-1)?.type).toBe('done');
        expect(transport.attempts).toEqual(['only-token']);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('retains a parallel call announced before the configured settle deadline', async () => {
    vi.useFakeTimers();
    try {
      // Given: call B arrives immediately before a deterministic inactivity
      // deadline rather than depending on event-loop scheduling speed.
      const request = parallelToolRequest();
      const wireName = wireToolName(request);
      const transport = new ScriptedTransport((stream) => {
        stream.emit('response', { ':status': 200 });
        stream.emit('data', callBatch(wireName, 'call-a', 'A'));
        setTimeout(() => {
          stream.emit('data', callBatch(wireName, 'call-b', 'B'));
          stream.emit('data', trailer());
        }, 99);
      });
      const completion = collect(
        backend(transport, undefined, { CURSOR_BRIDGE_STICKY_SETTLE_MS: '100' }),
        request,
      );
      await transport.firstRun;

      // When: terminal delivery and the deadline are advanced explicitly.
      await vi.advanceTimersByTimeAsync(200);
      const events = await completion;

      // Then: the later call is retained in the exact parallel batch.
      const completed = events.filter((event) => event.type === 'tool_call_complete');
      expect(completed.map((event) => JSON.parse(event.call.function.arguments).value)).toEqual([
        'A',
        'B',
      ]);
      expect(events.at(-1)?.type).toBe('done');
      expect(transport.attempts).toEqual(['only-token']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains a late parallel sibling across the hold boundary into the resume phase', async () => {
    // Given: call A completes, the OpenAI response settles after the sticky
    // window, and only then is call B announced on the same wire.
    const request = parallelToolRequest();
    const wireName = wireToolName(request);
    const transport = new ScriptedTransport((stream) => {
      stream.emit('response', { ':status': 200 });
      stream.emit('data', callBatch(wireName, 'call-a', 'A'));
    });
    const cursor = backend(transport);

    // When: the first response settles with call A, then B arrives.
    const first = await collect(cursor, request);
    const firstCall = first.find((event) => event.type === 'tool_call_complete');
    if (firstCall?.type !== 'tool_call_complete') throw new Error('missing late call A');
    expect(JSON.parse(firstCall.call.function.arguments)).toEqual({ value: 'A' });
    const run = await transport.firstRun;
    run.stream.emit('data', callBatch(wireName, 'call-b', 'B'));

    // And: the client executes A and posts its result.
    const followUp: ChatCompletionRequest = {
      ...request,
      messages: [
        ...request.messages,
        {
          role: 'assistant',
          content: '',
          tool_calls: [firstCall.call],
        },
        { role: 'tool', tool_call_id: firstCall.call.id, content: 'result-A' },
      ],
    };
    const second = await collect(cursor, followUp);

    // Then: B survived the hold boundary and is the only fresh call surfaced
    // on the resumed phase (A was already handed over in the first response).
    const secondCall = second.find((event) => event.type === 'tool_call_complete');
    if (secondCall?.type !== 'tool_call_complete') throw new Error('missing late call B');
    expect(JSON.parse(secondCall.call.function.arguments)).toEqual({ value: 'B' });
    expect(secondCall.call.id).not.toBe(firstCall.call.id);
    expect(second.at(-1)?.type).toBe('done');
    expect(transport.attempts).toEqual(['only-token']);
  });

  it('settles a text-only run at the stream trailer', async () => {
    // Given: a text run whose stream ends with a Connect trailer.
    const transport = new ScriptedTransport((stream) => {
      stream.emit('response', { ':status': 200 });
      stream.emit(
        'data',
        Buffer.concat([
          update('textDelta', { text: 'TRAILER_OK' }),
          update('turnEnded', { inputTokens: 2, outputTokens: 1 }),
          trailer(),
        ]),
      );
    });

    // When: the client consumes the stream.
    const events = await collect(backend(transport), {
      model: 'composer-2.5',
      messages: [{ role: 'user', content: 'answer' }],
    });

    // Then: content settles exactly at the stream boundary.
    expect(events).toEqual([
      { type: 'content', text: 'TRAILER_OK' },
      {
        type: 'done',
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        usage_source: 'turnEnded',
        is_error: false,
      },
    ]);
    expect(transport.attempts).toEqual(['only-token']);
  });
});
