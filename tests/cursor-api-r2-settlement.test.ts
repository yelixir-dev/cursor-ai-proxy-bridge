import { describe, expect, it } from 'vitest';
import type { ChatCompletionRequest } from '../src/backend/types.js';
import {
  backend,
  callBatch,
  collect,
  parallelToolRequest,
  ScriptedTransport,
  trailer,
  update,
  wireToolName,
} from './support/cursor-api-scripted.js';

describe('cursor-api authoritative Run settlement', () => {
  it.each([1, 3])(
    'retains a parallel call delivered after %i later data deliveries and settles at the trailer',
    async (deliveries) => {
      // Given: call A completes first, then unrelated data events arrive before
      // call B is announced in an independent later delivery, and the upstream
      // stream ends with a Connect trailer.
      const request = parallelToolRequest();
      const wireName = wireToolName(request);
      const transport = new ScriptedTransport((stream) => {
        stream.emit('response', { ':status': 200 });
        stream.emit('data', callBatch(wireName, 'call-a', 'A'));
        let remaining = deliveries;
        const deliverTraffic = () => {
          if (remaining > 0) {
            remaining -= 1;
            stream.emit('data', update('thinkingDelta', { text: `note-${remaining}` }));
            setImmediate(deliverTraffic);
            return;
          }
          stream.emit('data', callBatch(wireName, 'call-b', 'B'));
          stream.emit('data', trailer());
        };
        setImmediate(deliverTraffic);
      });

      // When: the client consumes the incremental stream.
      const events = await collect(backend(transport), request);

      // Then: starts and deltas stay incremental, and the settled batch is exact.
      const toolEvents = events.filter(
        (event) => event.type === 'tool_call_start' || event.type === 'tool_call_arguments_delta',
      );
      expect(events[0]).toMatchObject({ type: 'tool_call_start', id: 'call-a' });
      expect(toolEvents.map((event) => event.type)).toEqual([
        'tool_call_start',
        'tool_call_arguments_delta',
        'tool_call_start',
        'tool_call_arguments_delta',
      ]);
      expect(
        events.filter((event) => event.type === 'tool_call_complete').map((event) => event.call.id),
      ).toEqual(['call-a', 'call-b']);
      expect(events.at(-1)?.type).toBe('done');
      expect(transport.attempts).toEqual(['only-token']);
    },
  );

  it('retains a parallel call announced after any finite event-loop drain window', async () => {
    // Given: call A completes, no further data arrives for several event-loop
    // turns, and only then is call B announced in a later data event before
    // the upstream stream ends.
    const request = parallelToolRequest();
    const wireName = wireToolName(request);
    const transport = new ScriptedTransport((stream) => {
      stream.emit('response', { ':status': 200 });
      stream.emit('data', callBatch(wireName, 'call-a', 'A'));
      const afterDrainTurns = (remaining: number, deliver: () => void) => {
        if (remaining > 0) {
          setImmediate(() => afterDrainTurns(remaining - 1, deliver));
          return;
        }
        deliver();
      };
      afterDrainTurns(3, () => {
        stream.emit('data', callBatch(wireName, 'call-b', 'B'));
        stream.emit('data', trailer());
      });
    });

    // When: the client consumes the incremental stream.
    const events = await collect(backend(transport), request);

    // Then: the later call is retained and the final batch is exact, because
    // settlement waits for the authoritative stream boundary, not a drain window.
    expect(
      events.filter((event) => event.type === 'tool_call_complete').map((event) => event.call.id),
    ).toEqual(['call-a', 'call-b']);
    expect(events.at(-1)?.type).toBe('done');
    expect(transport.attempts).toEqual(['only-token']);
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
    expect(
      first.filter((event) => event.type === 'tool_call_complete').map((event) => event.call.id),
    ).toEqual(['call-a']);
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
          tool_calls: [
            {
              id: 'call-a',
              type: 'function',
              function: { name: 'echo_value', arguments: '{"value":"A"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call-a', content: 'result-A' },
      ],
    };
    const second = await collect(cursor, followUp);

    // Then: B survived the hold boundary and is the only fresh call surfaced
    // on the resumed phase (A was already handed over in the first response).
    expect(
      second.filter((event) => event.type === 'tool_call_complete').map((event) => event.call.id),
    ).toEqual(['call-b']);
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
