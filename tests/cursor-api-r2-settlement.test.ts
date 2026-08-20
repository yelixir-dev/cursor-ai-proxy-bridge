import { describe, expect, it } from 'vitest';
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

  it('holds a settled-looking batch open until the upstream turn ends', async () => {
    // Given: call A is complete with no further data pending, and the test
    // controls every later delivery from the client's event subscription.
    const request = parallelToolRequest();
    const wireName = wireToolName(request);
    const transport = new ScriptedTransport((stream) => {
      stream.emit('response', { ':status': 200 });
      stream.emit('data', callBatch(wireName, 'call-a', 'A'));
    });
    const iterator = backend(transport).completeStream(request)[Symbol.asyncIterator]();
    const nextEvent = () => iterator.next().then((result) => result.value);

    // When: A's start and argument delta are consumed, and no boundary arrived.
    await expect(nextEvent()).resolves.toEqual({
      type: 'tool_call_start',
      index: 0,
      id: 'call-a',
      name: 'echo_value',
    });
    await expect(nextEvent()).resolves.toEqual({
      type: 'tool_call_arguments_delta',
      index: 0,
      id: 'call-a',
      delta: '{"value":"A"}',
    });
    const run = await transport.firstRun;
    const deadline = AbortSignal.timeout(500);
    const racing = iterator.next().then((result) => ({ status: 'event' as const, result }));
    const premature = await Promise.race([
      racing,
      new Promise<{ status: 'pending' }>((resolve) => {
        deadline.addEventListener('abort', () => resolve({ status: 'pending' }), { once: true });
      }),
    ]);

    // Then: no terminal event exists before the authoritative boundary, a
    // later parallel call is still retained, and turnEnded settles exactly.
    expect(premature).toEqual({ status: 'pending' });
    run.stream.emit('data', callBatch(wireName, 'call-b', 'B'));
    await expect(racing).resolves.toEqual({
      status: 'event',
      result: {
        done: false,
        value: { type: 'tool_call_start', index: 1, id: 'call-b', name: 'echo_value' },
      },
    });
    await expect(nextEvent()).resolves.toEqual({
      type: 'tool_call_arguments_delta',
      index: 1,
      id: 'call-b',
      delta: '{"value":"B"}',
    });
    run.stream.emit('data', update('turnEnded', { inputTokens: 9, outputTokens: 5 }));
    await expect(nextEvent()).resolves.toEqual({
      type: 'tool_call_complete',
      index: 0,
      call: {
        id: 'call-a',
        type: 'function',
        function: { name: 'echo_value', arguments: '{"value":"A"}' },
      },
    });
    await expect(nextEvent()).resolves.toEqual({
      type: 'tool_call_complete',
      index: 1,
      call: {
        id: 'call-b',
        type: 'function',
        function: { name: 'echo_value', arguments: '{"value":"B"}' },
      },
    });
    await expect(nextEvent()).resolves.toEqual({
      type: 'done',
      usage: { prompt_tokens: 9, completion_tokens: 5, total_tokens: 14 },
      usage_source: 'turnEnded',
      is_error: false,
    });
    await iterator.return?.();
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
