import { describe, expect, it, vi } from 'vitest';
import { CursorCommandAbortedError } from '../src/backend/cursor-cli.js';
import { encodeConnectFrame } from '../src/backend/cursor-api/connect-frame.js';
import { DEFAULT_STICKY_SETTLE_MS } from '../src/backend/cursor-api/run-execution.js';
import type { CompletionStreamEvent } from '../src/backend/types.js';
import { attachRequestTrace, createRequestTrace, type TraceRecord } from '../src/trace.js';
import {
  backend,
  callBatch,
  collect,
  mcpArgsFrame,
  parallelToolRequest,
  ScriptedTransport,
  toolCall,
  trailer,
  update,
  wireToolName,
} from './support/cursor-api-scripted.js';

function completedValues(events: readonly CompletionStreamEvent[]): unknown[] {
  return events.flatMap((event) =>
    event.type === 'tool_call_complete' ? [JSON.parse(event.call.function.arguments).value] : [],
  );
}

describe('cursor-api sticky hold with an incomplete sibling', () => {
  it('replays changed tool policy on a fresh Run and rejects forbidden tool output', async () => {
    // Given: response 1 surfaces A and parks its still-active Run.
    const request = parallelToolRequest();
    const wireName = wireToolName(request);
    const transport = new ScriptedTransport((stream) => {
      stream.emit('response', { ':status': 200 });
      stream.emit('data', callBatch(wireName, 'call-a', 'A'));
    });
    const cursor = backend(transport);
    const first = await collect(cursor, request);
    const callA = first.find((event) => event.type === 'tool_call_complete');
    if (callA?.type !== 'tool_call_complete') throw new Error('missing policy call A');

    // When: response 2 explicitly forbids tools while submitting A's result.
    const run = await transport.firstRun;
    const originalWrites = run.stream.writes.length;
    const emitted: CompletionStreamEvent[] = [];
    const continuation = (async () => {
      for await (const event of cursor.completeStream({
        ...request,
        tool_choice: 'none',
        messages: [
          ...request.messages,
          { role: 'assistant', content: '', tool_calls: [callA.call] },
          { role: 'tool', tool_call_id: callA.call.id, content: 'result-A' },
        ],
      })) {
        emitted.push(event);
      }
    })();
    // Then: the fresh Run enforces the new policy before any forbidden output.
    await expect(continuation).rejects.toMatchObject({ name: 'CursorUndeclaredToolCallError' });
    expect(
      emitted.filter(
        (event) => event.type === 'tool_call_start' || event.type === 'tool_call_arguments_delta',
      ),
    ).toEqual([]);
    expect(run.stream.destroyed || run.stream.writableEnded).toBe(true);
    expect(run.stream.writes).toHaveLength(originalWrites);
    expect(transport.opened).toHaveLength(2);
  });

  it('preserves a completed hidden sibling before a malformed payload', async () => {
    // Given: A is parked and a valid completed hidden sibling B precedes a
    // Connect payload that cannot decode as AgentServerMessage protobuf.
    const request = { ...parallelToolRequest(), parallel_tool_calls: false };
    const wireName = wireToolName(request);
    const transport = new ScriptedTransport((stream) => {
      stream.emit('response', { ':status': 200 });
      if (transport.opened.length === 1) {
        stream.emit('data', callBatch(wireName, 'call-a', 'A'));
        return;
      }
      stream.emit(
        'data',
        Buffer.concat([update('textDelta', { text: 'unexpected fresh Run' }), trailer()]),
      );
    });
    const cursor = backend(transport);
    const first = await collect(cursor, request);
    const callA = first.find((event) => event.type === 'tool_call_complete');
    if (callA?.type !== 'tool_call_complete') throw new Error('missing malformed call A');
    const firstRun = await transport.firstRun;
    firstRun.stream.emit(
      'data',
      Buffer.concat([callBatch(wireName, 'call-b', 'B'), encodeConnectFrame(Buffer.from([0x0a]))]),
    );

    // When: A's result resumes the held Run.
    const second = await collect(cursor, {
      ...request,
      messages: [
        ...request.messages,
        { role: 'assistant', content: '', tool_calls: [callA.call] },
        { role: 'tool', tool_call_id: callA.call.id, content: 'result-A' },
      ],
    });

    // Then: the later parse error terminates the Run but cannot erase B.
    expect(completedValues(second)).toEqual(['B']);
    expect(transport.opened).toHaveLength(1);
  });

  it('preserves a completed hidden sibling before an RPC-error trailer', async () => {
    // Given: A is parked and one delivery contains completed hidden sibling B
    // immediately before an error-bearing Connect trailer.
    const request = { ...parallelToolRequest(), parallel_tool_calls: false };
    const wireName = wireToolName(request);
    const transport = new ScriptedTransport((stream) => {
      stream.emit('response', { ':status': 200 });
      if (transport.opened.length === 1) {
        stream.emit('data', callBatch(wireName, 'call-a', 'A'));
        return;
      }
      stream.emit(
        'data',
        Buffer.concat([update('textDelta', { text: 'unexpected fresh Run' }), trailer()]),
      );
    });
    const cursor = backend(transport);
    const first = await collect(cursor, request);
    const callA = first.find((event) => event.type === 'tool_call_complete');
    if (callA?.type !== 'tool_call_complete') throw new Error('missing RPC-error call A');
    const firstRun = await transport.firstRun;
    firstRun.stream.emit('data', callBatch(wireName, 'call-b', 'B'));
    firstRun.stream.emit(
      'data',
      encodeConnectFrame(
        Buffer.from(
          JSON.stringify({ error: { code: 'internal', message: 'late upstream failure' } }),
        ),
        { trailer: true },
      ),
    );

    // When: A's result resumes the original Run.
    const second = await collect(cursor, {
      ...request,
      messages: [
        ...request.messages,
        { role: 'assistant', content: '', tool_calls: [callA.call] },
        { role: 'tool', tool_call_id: callA.call.id, content: 'result-A' },
      ],
    });

    // Then: B survives exactly like a transport error delivered after B.
    const callB = second.find((event) => event.type === 'tool_call_complete');
    expect(callB?.type).toBe('tool_call_complete');
    if (callB?.type === 'tool_call_complete') {
      expect(JSON.parse(callB.call.function.arguments)).toEqual({ value: 'B' });
    }
    expect(transport.opened).toHaveLength(1);
  });

  it('removes a parked hold before output-limit teardown', async () => {
    // Given: A is parked, hidden B has completed, and a later wire chunk
    // exceeds the configured output limit.
    const request = { ...parallelToolRequest(), parallel_tool_calls: false };
    const wireName = wireToolName(request);
    const transport = new ScriptedTransport((stream) => {
      stream.emit('response', { ':status': 200 });
      if (transport.opened.length === 1) {
        stream.emit('data', callBatch(wireName, 'call-a', 'A'));
        return;
      }
      stream.emit(
        'data',
        Buffer.concat([
          update('textDelta', { text: 'fresh after overflow' }),
          update('turnEnded', { inputTokens: 3, outputTokens: 1 }),
          trailer(),
        ]),
      );
    });
    const cursor = backend(transport, undefined, {
      CURSOR_BRIDGE_MAX_OUTPUT_BYTES: '2048',
    });
    const first = await collect(cursor, request);
    const call = first.find((event) => event.type === 'tool_call_complete');
    if (call?.type !== 'tool_call_complete') throw new Error('missing overflow call');
    const firstRun = await transport.firstRun;
    firstRun.stream.emit('data', callBatch(wireName, 'call-b', 'B'));
    firstRun.stream.emit('data', Buffer.alloc(3_000));

    // When: A's result arrives after the unsafe Run was torn down.
    const continuation = collect(cursor, {
      ...request,
      messages: [
        ...request.messages,
        { role: 'assistant', content: '', tool_calls: [call.call] },
        { role: 'tool', tool_call_id: call.call.id, content: 'result-A' },
      ],
    });
    const timeout = Promise.withResolvers<never>();
    const timeoutSignal = AbortSignal.timeout(100);
    timeoutSignal.addEventListener(
      'abort',
      () => timeout.reject(new Error('overflow left a stale parked Run')),
      { once: true },
    );

    // Then: the output-limit failure removed the hold despite hidden B.
    await expect(Promise.race([continuation, timeout.promise])).resolves.toContainEqual({
      type: 'content',
      text: 'fresh after overflow',
    });
    expect(transport.opened).toHaveLength(2);
  });

  it('releases a parked Run on stream error without waiting for close', async () => {
    // Given: A has parked and the stream emits an error without a close event.
    const request = { ...parallelToolRequest(), parallel_tool_calls: false };
    const wireName = wireToolName(request);
    const transport = new ScriptedTransport((stream) => {
      stream.emit('response', { ':status': 200 });
      if (transport.opened.length === 1) {
        stream.emit('data', callBatch(wireName, 'call-a', 'A'));
        return;
      }
      stream.emit(
        'data',
        Buffer.concat([
          update('textDelta', { text: 'fresh after error' }),
          update('turnEnded', { inputTokens: 3, outputTokens: 1 }),
          trailer(),
        ]),
      );
    });
    const cursor = backend(transport);
    const first = await collect(cursor, request);
    const call = first.find((event) => event.type === 'tool_call_complete');
    if (call?.type !== 'tool_call_complete') throw new Error('missing stream-error call');
    const firstRun = await transport.firstRun;
    firstRun.stream.emit('error', new Error('upstream stream failed'));

    // When: A's result is submitted after the error.
    const continuation = collect(cursor, {
      ...request,
      messages: [
        ...request.messages,
        { role: 'assistant', content: '', tool_calls: [call.call] },
        { role: 'tool', tool_call_id: call.call.id, content: 'result-A' },
      ],
    });
    const timeout = Promise.withResolvers<never>();
    const timeoutSignal = AbortSignal.timeout(100);
    timeoutSignal.addEventListener(
      'abort',
      () => timeout.reject(new Error('stale parked Run did not settle')),
      { once: true },
    );

    // Then: the errored hold is gone, so request 2 opens a fresh Run instead
    // of taking a settled HeldRun whose resume method never resolves.
    await expect(Promise.race([continuation, timeout.promise])).resolves.toContainEqual({
      type: 'content',
      text: 'fresh after error',
    });
    expect(transport.opened).toHaveLength(2);
  });

  it('releases a parked Run when a trailer arrives without hidden siblings', async () => {
    // Given: A settles by inactivity and parks, then the native Run terminates
    // before the client returns A's result.
    const request = { ...parallelToolRequest(), parallel_tool_calls: false };
    const wireName = wireToolName(request);
    const transport = new ScriptedTransport((stream) => {
      stream.emit('response', { ':status': 200 });
      if (transport.opened.length === 1) {
        stream.emit('data', callBatch(wireName, 'call-a', 'A'));
        return;
      }
      stream.emit(
        'data',
        Buffer.concat([
          update('textDelta', { text: 'fresh after parked trailer' }),
          update('turnEnded', { inputTokens: 3, outputTokens: 1 }),
          trailer(),
        ]),
      );
    });
    const cursor = backend(transport);
    const first = await collect(cursor, request);
    const call = first.find((event) => event.type === 'tool_call_complete');
    if (call?.type !== 'tool_call_complete') throw new Error('missing parked trailer call');
    const firstRun = await transport.firstRun;
    firstRun.stream.emit('data', trailer());

    // When: A's result arrives after the parked Run has terminated.
    const continuation = await collect(cursor, {
      ...request,
      messages: [
        ...request.messages,
        { role: 'assistant', content: '', tool_calls: [call.call] },
        { role: 'tool', tool_call_id: call.call.id, content: 'result-A' },
      ],
    });

    // Then: no stale hold is resumed into a done-only empty response.
    expect(continuation).toContainEqual({
      type: 'content',
      text: 'fresh after parked trailer',
    });
    expect(transport.opened).toHaveLength(2);
  });

  it('does not park a completed call when turnEnded precedes the trailer', async () => {
    // Given: upstream emits call A and the authoritative turn boundary in one
    // chunk, while the Connect trailer arrives only after response 1 settles.
    const request = { ...parallelToolRequest(), parallel_tool_calls: false };
    const wireName = wireToolName(request);
    const transport = new ScriptedTransport((stream) => {
      stream.emit('response', { ':status': 200 });
      if (transport.opened.length === 1) {
        stream.emit(
          'data',
          Buffer.concat([
            callBatch(wireName, 'call-a', 'A'),
            update('turnEnded', { inputTokens: 2, outputTokens: 1 }),
          ]),
        );
        return;
      }
      stream.emit(
        'data',
        Buffer.concat([
          update('textDelta', { text: 'fresh continuation' }),
          update('turnEnded', { inputTokens: 3, outputTokens: 1 }),
          trailer(),
        ]),
      );
    });
    const cursor = backend(transport);
    const first = await collect(cursor, request);
    const call = first.find((event) => event.type === 'tool_call_complete');
    if (call?.type !== 'tool_call_complete') throw new Error('missing split-terminal call');
    const firstRun = await transport.firstRun;
    firstRun.stream.emit('data', trailer());

    // When: the client returns A after that native turn has already ended.
    const continuation = await collect(cursor, {
      ...request,
      messages: [
        ...request.messages,
        { role: 'assistant', content: '', tool_calls: [call.call] },
        { role: 'tool', tool_call_id: call.call.id, content: 'result-A' },
      ],
    });

    // Then: the bridge opens a fresh Run instead of resuming the terminal Run
    // and returning an empty completion after replaying the trailer.
    expect(continuation).toContainEqual({ type: 'content', text: 'fresh continuation' });
    expect(transport.opened).toHaveLength(2);
  });

  it('hands resumed text and thinking to the continuation emitter', async () => {
    // Given: request 1 parks after returning call A.
    const request = { ...parallelToolRequest(), parallel_tool_calls: false };
    const wireName = wireToolName(request);
    const transport = new ScriptedTransport((stream) => {
      stream.emit('response', { ':status': 200 });
      stream.emit('data', callBatch(wireName, 'call-a', 'A'));
    });
    const cursor = backend(transport);
    const first = await collect(cursor, request);
    const call = first.find((event) => event.type === 'tool_call_complete');
    if (call?.type !== 'tool_call_complete') throw new Error('missing emitter handoff call');

    // When: request 2 resumes the Run and upstream emits thinking and text.
    const run = await transport.firstRun;
    const resultWritten = Promise.withResolvers<void>();
    run.stream.once('write', () => resultWritten.resolve());
    const continuation = collect(cursor, {
      ...request,
      messages: [
        ...request.messages,
        { role: 'assistant', content: '', tool_calls: [call.call] },
        { role: 'tool', tool_call_id: call.call.id, content: 'result-A' },
      ],
    });
    await resultWritten.promise;
    run.stream.emit(
      'data',
      Buffer.concat([
        update('thinkingDelta', { text: 'resumed thought' }),
        update('textDelta', { text: 'resumed text' }),
        update('turnEnded', { inputTokens: 2, outputTokens: 1 }),
        trailer(),
      ]),
    );

    // Then: both incremental event types belong to request 2's emitter.
    expect(await continuation).toEqual([
      { type: 'thinking', text: 'resumed thought' },
      { type: 'content', text: 'resumed text' },
      {
        type: 'done',
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        usage_source: 'turnEnded',
        is_error: false,
      },
    ]);
  });

  it('flushes text buffered while parked into the continuation emitter', async () => {
    // Given: request 1 parks after call A, then the upstream Run emits text
    // while no OpenAI request owns its emitter.
    const request = { ...parallelToolRequest(), parallel_tool_calls: false };
    const wireName = wireToolName(request);
    const transport = new ScriptedTransport((stream) => {
      stream.emit('response', { ':status': 200 });
      stream.emit('data', callBatch(wireName, 'call-a', 'A'));
    });
    const cursor = backend(transport);
    const first = await collect(cursor, request);
    const call = first.find((event) => event.type === 'tool_call_complete');
    if (call?.type !== 'tool_call_complete') throw new Error('missing text backlog call');
    const run = await transport.firstRun;
    run.stream.emit(
      'data',
      Buffer.concat([
        update('thinkingDelta', { text: 'PARKED_THOUGHT' }),
        update('textDelta', { text: 'HIDDEN_' }),
      ]),
    );

    // When: request 2 resumes and receives a later live text delta.
    const resultWritten = Promise.withResolvers<void>();
    run.stream.once('write', () => resultWritten.resolve());
    const continuation = collect(cursor, {
      ...request,
      messages: [
        ...request.messages,
        { role: 'assistant', content: '', tool_calls: [call.call] },
        { role: 'tool', tool_call_id: call.call.id, content: 'result-A' },
      ],
    });
    await resultWritten.promise;
    run.stream.emit(
      'data',
      Buffer.concat([
        update('textDelta', { text: 'VISIBLE' }),
        update('turnEnded', { inputTokens: 2, outputTokens: 1 }),
        trailer(),
      ]),
    );

    // Then: parked and live text are delivered exactly once and in order.
    expect(
      (await continuation).filter((event) => event.type === 'thinking' || event.type === 'content'),
    ).toEqual([
      { type: 'thinking', text: 'PARKED_THOUGHT' },
      { type: 'content', text: 'HIDDEN_' },
      { type: 'content', text: 'VISIBLE' },
    ]);
  });

  it('drains hidden serial siblings before releasing a terminal Run', async () => {
    // Given: upstream completes A and B, then closes before either result.
    const request = { ...parallelToolRequest(), parallel_tool_calls: false };
    const wireName = wireToolName(request);
    const transport = new ScriptedTransport((stream) => {
      stream.emit('response', { ':status': 200 });
      if (transport.opened.length === 1) {
        stream.emit(
          'data',
          Buffer.concat([
            callBatch(wireName, 'call-a', 'A'),
            callBatch(wireName, 'call-b', 'B'),
            trailer(),
          ]),
        );
        stream.emit('close');
        return;
      }
      stream.emit(
        'data',
        Buffer.concat([
          update('textDelta', { text: 'replacement final' }),
          update('turnEnded', { inputTokens: 2, outputTokens: 1 }),
          trailer(),
        ]),
      );
    });
    const cursor = backend(transport);
    const firstEvents = await collect(cursor, request);
    const callA = firstEvents.find((event) => event.type === 'tool_call_complete');
    if (callA?.type !== 'tool_call_complete') throw new Error('missing terminal call A');

    // When: A's result arrives after the native stream has ended.
    const historyAfterA = [
      ...request.messages,
      { role: 'assistant' as const, content: '', tool_calls: [callA.call] },
      { role: 'tool' as const, tool_call_id: callA.call.id, content: 'result-A' },
    ];
    const secondEvents = await collect(cursor, { ...request, messages: historyAfterA });
    const callB = secondEvents.find((event) => event.type === 'tool_call_complete');

    // Then: B is drained from the terminal Run instead of being dropped.
    expect(
      JSON.parse(callB?.type === 'tool_call_complete' ? callB.call.function.arguments : '{}'),
    ).toEqual({
      value: 'B',
    });
    expect(transport.opened).toHaveLength(1);
    if (callB?.type !== 'tool_call_complete') throw new Error('missing terminal call B');

    // And: after the terminal queue is exhausted, B's result starts a fresh
    // Run that can produce the final answer.
    const final = await collect(cursor, {
      ...request,
      messages: [
        ...historyAfterA,
        { role: 'assistant', content: '', tool_calls: [callB.call] },
        { role: 'tool', tool_call_id: callB.call.id, content: 'result-B' },
      ],
    });
    expect(final).toContainEqual({ type: 'content', text: 'replacement final' });
    expect(transport.opened).toHaveLength(2);
  });

  it('replays a trailer buffered behind a parked serial sibling', async () => {
    // Given: A is parked, then B and the terminal trailer arrive together.
    const request = { ...parallelToolRequest(), parallel_tool_calls: false };
    const wireName = wireToolName(request);
    const transport = new ScriptedTransport((stream) => {
      stream.emit('response', { ':status': 200 });
      if (transport.opened.length === 1) {
        stream.emit('data', callBatch(wireName, 'call-a', 'A'));
        return;
      }
      stream.emit(
        'data',
        Buffer.concat([
          update('textDelta', { text: 'post-terminal final' }),
          update('turnEnded', { inputTokens: 2, outputTokens: 1 }),
          trailer(),
        ]),
      );
    });
    const cursor = backend(transport, undefined, {
      CURSOR_BRIDGE_CURSOR_TIMEOUT_MS: '50',
    });
    const firstEvents = await collect(cursor, request);
    const run = await transport.firstRun;
    const callA = firstEvents.find((event) => event.type === 'tool_call_complete');
    if (callA?.type !== 'tool_call_complete') throw new Error('missing parked call A');
    run.stream.emit('data', Buffer.concat([callBatch(wireName, 'call-b', 'B'), trailer()]));

    // When: A's result replays the payloads buffered while parked.
    const historyAfterA = [
      ...request.messages,
      { role: 'assistant' as const, content: '', tool_calls: [callA.call] },
      { role: 'tool' as const, tool_call_id: callA.call.id, content: 'result-A' },
    ];
    const secondEvents = await collect(cursor, { ...request, messages: historyAfterA });
    const callB = secondEvents.find((event) => event.type === 'tool_call_complete');
    if (callB?.type !== 'tool_call_complete') throw new Error('missing buffered call B');

    // Then: the buffered trailer prevents another impossible resume, so B's
    // result opens a replacement Run instead of timing out on the closed one.
    const final = await collect(cursor, {
      ...request,
      messages: [
        ...historyAfterA,
        { role: 'assistant', content: '', tool_calls: [callB.call] },
        { role: 'tool', tool_call_id: callB.call.id, content: 'result-B' },
      ],
    });
    expect(final).toContainEqual({ type: 'content', text: 'post-terminal final' });
    expect(transport.opened).toHaveLength(2);
  });

  it('binds a resumed held Run to the continuation request abort signal', async () => {
    vi.useFakeTimers();
    try {
      // Given: request 1 has returned a tool call while its native Run stays held.
      const request = { ...parallelToolRequest(), parallel_tool_calls: false };
      const wireName = wireToolName(request);
      const transport = new ScriptedTransport((stream) => {
        stream.emit('response', { ':status': 200 });
        stream.emit('data', callBatch(wireName, 'call-a', 'A'));
      });
      const cursor = backend(transport, undefined, {
        CURSOR_BRIDGE_CURSOR_TIMEOUT_MS: '50',
      });
      const first = collect(cursor, request);
      const run = await transport.firstRun;
      await vi.advanceTimersByTimeAsync(5);
      const firstEvents = await first;
      const completed = firstEvents.find((event) => event.type === 'tool_call_complete');
      if (completed?.type !== 'tool_call_complete') throw new Error('missing held tool call');

      // When: request 2 resumes the Run and then its own client disconnects.
      const controller = new AbortController();
      const resultWritten = Promise.withResolvers<void>();
      run.stream.once('write', () => resultWritten.resolve());
      const continuation = (async () => {
        const stream = cursor.completeStream(
          {
            ...request,
            messages: [
              ...request.messages,
              { role: 'assistant', content: '', tool_calls: [completed.call] },
              { role: 'tool', tool_call_id: completed.call.id, content: 'result-A' },
            ],
          },
          controller.signal,
        );
        const iterator = stream[Symbol.asyncIterator]();
        while (!(await iterator.next()).done) {
          // The upstream is intentionally silent after accepting the result.
        }
      })();
      const continuationOutcome = continuation.then(
        () => undefined,
        (error: unknown) => error,
      );
      await resultWritten.promise;
      controller.abort();
      await Promise.resolve();

      // Then: the continuation owns cancellation and tears down immediately,
      // rather than retaining the native Run until its independent timeout.
      expect(run.stream.writableEnded || run.stream.destroyed).toBe(true);
      expect(await continuationOutcome).toBeInstanceOf(CursorCommandAbortedError);
    } finally {
      await vi.runAllTimersAsync();
      vi.useRealTimers();
    }
  });

  it('routes a surfaced provisional id to its authoritative held exec', async () => {
    vi.useFakeTimers();
    const continuationAbort = new AbortController();
    try {
      // Given: streaming exposes a provisional id before mcpArgs completes
      // the same call with a different authoritative id.
      const request = { ...parallelToolRequest(), parallel_tool_calls: false };
      const wireName = wireToolName(request);
      const transport = new ScriptedTransport((stream) => {
        stream.emit('response', { ':status': 200 });
        stream.emit(
          'data',
          Buffer.concat([
            update('toolCallStarted', {
              callId: 'envelope-a',
              toolCall: {
                tool: {
                  case: 'mcpToolCall',
                  value: { args: toolCall(wireName, 'call-provisional', '') },
                },
                toolCallId: 'call-provisional',
              },
            }),
            update('partialToolCall', {
              callId: 'envelope-a',
              argsTextDelta: '{"value":"A"}',
            }),
            mcpArgsFrame(toolCall(wireName, 'call-authoritative', 'A')),
          ]),
        );
      });
      const cursor = backend(transport);
      const first = collect(cursor, request);
      const run = await transport.firstRun;
      await vi.advanceTimersByTimeAsync(5);
      const firstEvents = await first;
      const completed = firstEvents.find((event) => event.type === 'tool_call_complete');
      if (completed?.type !== 'tool_call_complete') throw new Error('missing drifted tool call');
      expect(completed.call.id).toMatch(/^call_[a-f0-9]{32}_0$/);
      const writesBeforeResult = run.stream.writes.length;

      // When: the client returns the id it was actually shown.
      const continuation = cursor.complete(
        {
          ...request,
          messages: [
            ...request.messages,
            { role: 'assistant', content: '', tool_calls: [completed.call] },
            { role: 'tool', tool_call_id: completed.call.id, content: 'result-A' },
          ],
        },
        continuationAbort.signal,
      );
      await Promise.resolve();

      // Then: the result is written to the authoritative held exec.
      expect(run.stream.writes).toHaveLength(writesBeforeResult + 1);
      run.stream.emit(
        'data',
        Buffer.concat([
          update('textDelta', { text: 'continued after drift' }),
          update('turnEnded', { inputTokens: 2, outputTokens: 1 }),
          trailer(),
        ]),
      );
      await expect(continuation).resolves.toMatchObject({ content: 'continued after drift' });
      expect(transport.opened).toHaveLength(1);
    } finally {
      continuationAbort.abort();
      vi.useRealTimers();
    }
  });

  it('does not replay pre-tool text into the final serial JSON response', async () => {
    vi.useFakeTimers();
    try {
      // Given: Composer emits explanatory text before pre-announcing serial
      // calls A and B on one native Run.
      const request = { ...parallelToolRequest(), parallel_tool_calls: false };
      const wireName = wireToolName(request);
      const transport = new ScriptedTransport((stream) => {
        stream.emit('response', { ':status': 200 });
        stream.emit(
          'data',
          Buffer.concat([
            update('textDelta', { text: 'starting serial sequence\n' }),
            callBatch(wireName, 'call-a', 'A'),
            callBatch(wireName, 'call-b', 'B'),
          ]),
        );
      });
      const cursor = backend(transport);
      const firstPromise = cursor.complete(request);
      const run = await transport.firstRun;
      await vi.advanceTimersByTimeAsync(5);
      const first = await firstPromise;
      const callA = first.tool_calls?.[0];
      if (!callA) throw new Error('missing first serial call');
      expect(first.content).toBeNull();

      const historyAfterA = [
        ...request.messages,
        { role: 'assistant' as const, content: '', tool_calls: [callA] },
        { role: 'tool' as const, tool_call_id: callA.id, content: 'result-A' },
      ];
      const second = await cursor.complete({ ...request, messages: historyAfterA });
      const callB = second.tool_calls?.[0];
      if (!callB) throw new Error('missing second serial call');
      expect(second.content).toBeNull();

      // When: B's result lets the native Run produce its final text.
      const finalPromise = cursor.complete({
        ...request,
        messages: [
          ...historyAfterA,
          { role: 'assistant', content: '', tool_calls: [callB] },
          { role: 'tool', tool_call_id: callB.id, content: 'result-B' },
        ],
      });
      run.stream.emit(
        'data',
        Buffer.concat([
          update('textDelta', { text: 'SERIAL_FINAL' }),
          update('turnEnded', { inputTokens: 4, outputTokens: 2 }),
          trailer(),
        ]),
      );

      // Then: text discarded by the earlier tool responses is not replayed.
      expect((await finalPromise).content).toBe('SERIAL_FINAL');
      expect(transport.opened).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces one serial call while preserving upstream announced counts and sticky resume', async () => {
    vi.useFakeTimers();
    try {
      // Given: upstream emits two external calls despite the client disabling
      // parallel calls.
      const request = { ...parallelToolRequest(), parallel_tool_calls: false };
      const records: TraceRecord[] = [];
      attachRequestTrace(
        request,
        createRequestTrace({
          environment: { CURSOR_BRIDGE_TRACE: '1' },
          requestId: 'serial-extra-call',
          model: request.model,
          sink: (record) => records.push(record),
        }),
      );
      const wireName = wireToolName(request);
      const openedReplacement = Promise.withResolvers<'new-run'>();
      const transport = new ScriptedTransport((stream) => {
        stream.emit('response', { ':status': 200 });
        if (transport.opened.length > 1) {
          openedReplacement.resolve('new-run');
          stream.emit(
            'data',
            Buffer.concat([
              update('textDelta', { text: 'replacement' }),
              update('turnEnded', { inputTokens: 1, outputTokens: 1 }),
              trailer(),
            ]),
          );
          return;
        }
        stream.emit(
          'data',
          Buffer.concat([callBatch(wireName, 'call-a', 'A'), callBatch(wireName, 'call-b', 'B')]),
        );
      });
      const cursor = backend(transport);
      const first = collect(cursor, request);
      const run = await transport.firstRun;
      await vi.advanceTimersByTimeAsync(5);
      const firstEvents = await first;
      const completed = firstEvents.find((event) => event.type === 'tool_call_complete');
      if (completed?.type !== 'tool_call_complete') throw new Error('missing serial tool call');
      expect(completedValues(firstEvents)).toEqual(['A']);
      expect(firstEvents.at(-1)).toMatchObject({
        type: 'done',
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        usage_source: 'unknown',
      });
      expect(records.find((record) => record.stage === 'tool_batch_complete')).toMatchObject({
        tool_calls_announced: 2,
        tool_calls_completed: 2,
      });

      // When: the client returns the only call it was given.
      const resumedA = Promise.withResolvers<'resumed'>();
      run.stream.once('write', () => resumedA.resolve('resumed'));
      const historyAfterA = [
        ...request.messages,
        { role: 'assistant' as const, content: '', tool_calls: [completed.call] },
        { role: 'tool' as const, tool_call_id: completed.call.id, content: 'result-A' },
      ];
      const second = collect(cursor, {
        ...request,
        messages: historyAfterA,
      });

      // Then: the held Run accepts A and surfaces the already-completed B as
      // a separate OpenAI response without opening a replacement Run.
      expect(await Promise.race([resumedA.promise, openedReplacement.promise])).toBe('resumed');
      const secondEvents = await second;
      const completedB = secondEvents.find((event) => event.type === 'tool_call_complete');
      if (completedB?.type !== 'tool_call_complete') {
        throw new Error('missing deferred serial tool call');
      }
      expect(completedValues(secondEvents)).toEqual(['B']);
      expect(secondEvents.at(-1)).toMatchObject({
        type: 'done',
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        usage_source: 'unknown',
      });

      // When: the client returns B after the earlier A history.
      const resumedB = Promise.withResolvers<'resumed'>();
      run.stream.once('write', () => resumedB.resolve('resumed'));
      const final = collect(cursor, {
        ...request,
        messages: [
          ...historyAfterA,
          { role: 'assistant', content: '', tool_calls: [completedB.call] },
          { role: 'tool', tool_call_id: completedB.call.id, content: 'result-B' },
        ],
      });
      expect(await Promise.race([resumedB.promise, openedReplacement.promise])).toBe('resumed');
      run.stream.emit(
        'data',
        Buffer.concat([
          update('textDelta', { text: 'continued' }),
          update('turnEnded', { inputTokens: 2, outputTokens: 1 }),
          trailer(),
        ]),
      );
      const continuedEvents = await final;
      expect(continuedEvents).toContainEqual({ type: 'content', text: 'continued' });
      expect(continuedEvents.at(-1)).toMatchObject({
        type: 'done',
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        usage_source: 'turnEnded',
      });
      expect(transport.opened).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for a sibling announced after the old default settle window', async () => {
    vi.useFakeTimers();
    try {
      // Given: call A completes immediately, while call B is not announced
      // until after the previous 250ms default would have parked the Run.
      const request = parallelToolRequest();
      const records: TraceRecord[] = [];
      attachRequestTrace(
        request,
        createRequestTrace({
          environment: { CURSOR_BRIDGE_TRACE: '1' },
          requestId: 'late-sibling-counts',
          model: request.model,
          sink: (record) => records.push(record),
        }),
      );
      const wireName = wireToolName(request);
      const transport = new ScriptedTransport((stream) => {
        stream.emit('response', { ':status': 200 });
        stream.emit('data', callBatch(wireName, 'call-a', 'A'));
        setTimeout(() => {
          stream.emit(
            'data',
            update('toolCallStarted', {
              callId: 'call-b',
              toolCall: {
                tool: {
                  case: 'mcpToolCall',
                  value: {
                    args: {
                      name: wireName,
                      toolName: wireName,
                      providerIdentifier: 'bridge',
                      toolCallId: 'call-b',
                      args: {},
                    },
                  },
                },
                toolCallId: 'call-b',
              },
            }),
          );
        }, 300);
        setTimeout(() => {
          stream.emit('data', callBatch(wireName, 'call-b', 'B'));
        }, 500);
      });
      const completion = collect(
        backend(transport, undefined, {
          CURSOR_BRIDGE_STICKY_SETTLE_MS: String(DEFAULT_STICKY_SETTLE_MS),
        }),
        request,
      );
      await transport.firstRun;

      // When: both the late announcement and its authoritative mcpArgs arrive.
      await vi.advanceTimersByTimeAsync(1_500);
      const events = await completion;

      // Then: the first OpenAI response contains the complete parallel batch.
      expect(completedValues(events)).toEqual(['A', 'B']);
      expect(events.at(-1)?.type).toBe('done');
      expect(records.find((record) => record.stage === 'tool_batch_complete')).toMatchObject({
        tool_calls_announced: 2,
        tool_calls_completed: 2,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains a sibling completed immediately before the settle deadline', async () => {
    vi.useFakeTimers();
    try {
      // Given: call B completes one millisecond before the original hold
      // would fire for call A.
      const request = parallelToolRequest();
      const wireName = wireToolName(request);
      const transport = new ScriptedTransport((stream) => {
        stream.emit('response', { ':status': 200 });
        stream.emit('data', callBatch(wireName, 'call-a', 'A'));
        setTimeout(() => {
          stream.emit('data', callBatch(wireName, 'call-b', 'B'));
        }, DEFAULT_STICKY_SETTLE_MS - 1);
      });
      const completion = collect(
        backend(transport, undefined, {
          CURSOR_BRIDGE_STICKY_SETTLE_MS: String(DEFAULT_STICKY_SETTLE_MS),
        }),
        request,
      );
      await transport.firstRun;

      // When: the reset settle window after B also expires.
      await vi.advanceTimersByTimeAsync(DEFAULT_STICKY_SETTLE_MS * 2);
      const events = await completion;

      // Then: both siblings remain in the same first response.
      expect(completedValues(events)).toEqual(['A', 'B']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('replays a serial sibling buffered while the first call is parked', async () => {
    vi.useFakeTimers();
    try {
      // Given: A is surfaced first and B arrives only after the native Run is
      // parked waiting for A's result.
      const request = { ...parallelToolRequest(), parallel_tool_calls: false };
      const wireName = wireToolName(request);
      const transport = new ScriptedTransport((stream) => {
        stream.emit('response', { ':status': 200 });
        stream.emit('data', callBatch(wireName, 'call-a', 'A'));
      });
      const cursor = backend(transport);
      const first = collect(cursor, request);
      const run = await transport.firstRun;
      await vi.advanceTimersByTimeAsync(5);
      const firstEvents = await first;
      const completedA = firstEvents.find((event) => event.type === 'tool_call_complete');
      if (completedA?.type !== 'tool_call_complete') throw new Error('missing first serial call');

      run.stream.emit('data', callBatch(wireName, 'call-b', 'B'));

      // When: A's result resumes the Run and replays the parked B frames.
      const historyAfterA = [
        ...request.messages,
        { role: 'assistant' as const, content: '', tool_calls: [completedA.call] },
        { role: 'tool' as const, tool_call_id: completedA.call.id, content: 'result-A' },
      ];
      const second = collect(cursor, { ...request, messages: historyAfterA });
      await vi.advanceTimersByTimeAsync(5);
      const secondEvents = await second;
      const completedB = secondEvents.find((event) => event.type === 'tool_call_complete');
      if (completedB?.type !== 'tool_call_complete') {
        throw new Error('missing buffered serial sibling');
      }
      expect(JSON.parse(completedB.call.function.arguments)).toEqual({ value: 'B' });

      // Then: B's result resumes the same Run and permits the final answer.
      const final = collect(cursor, {
        ...request,
        messages: [
          ...historyAfterA,
          { role: 'assistant', content: '', tool_calls: [completedB.call] },
          { role: 'tool', tool_call_id: completedB.call.id, content: 'result-B' },
        ],
      });
      run.stream.emit(
        'data',
        Buffer.concat([
          update('textDelta', { text: 'buffered continued' }),
          update('turnEnded', { inputTokens: 4, outputTokens: 2 }),
          trailer(),
        ]),
      );
      const finalEvents = await final;
      expect(finalEvents).toContainEqual({ type: 'content', text: 'buffered continued' });
      expect(transport.opened).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for a hidden serial sibling that completes after the first result', async () => {
    vi.useFakeTimers();
    try {
      // Given: A completes, while hidden B has only start/partial frames when
      // the serial response parks on A.
      const request = { ...parallelToolRequest(), parallel_tool_calls: false };
      const wireName = wireToolName(request);
      const transport = new ScriptedTransport((stream) => {
        stream.emit('response', { ':status': 200 });
        stream.emit(
          'data',
          Buffer.concat([
            callBatch(wireName, 'call-a', 'A'),
            update('toolCallStarted', {
              callId: 'call-b',
              toolCall: {
                tool: {
                  case: 'mcpToolCall',
                  value: { args: toolCall(wireName, 'call-b', '') },
                },
                toolCallId: 'call-b',
              },
            }),
            update('partialToolCall', {
              callId: 'call-b',
              argsTextDelta: '{"value":"B"}',
            }),
          ]),
        );
      });
      const cursor = backend(transport);
      const first = collect(cursor, request);
      const run = await transport.firstRun;
      await vi.advanceTimersByTimeAsync(5);
      const firstEvents = await first;
      const completedA = firstEvents.find((event) => event.type === 'tool_call_complete');
      if (completedA?.type !== 'tool_call_complete') throw new Error('missing first serial call');

      // When: A's result resumes the Run before B's authoritative mcpArgs.
      const resumed = Promise.withResolvers<void>();
      run.stream.once('write', () => resumed.resolve());
      const historyAfterA = [
        ...request.messages,
        { role: 'assistant' as const, content: '', tool_calls: [completedA.call] },
        { role: 'tool' as const, tool_call_id: completedA.call.id, content: 'result-A' },
      ];
      const second = collect(cursor, { ...request, messages: historyAfterA });
      await resumed.promise;
      run.stream.emit('data', mcpArgsFrame(toolCall(wireName, 'call-b', 'B')));
      await vi.advanceTimersByTimeAsync(5);
      const secondEvents = await second;
      const completedB = secondEvents.find((event) => event.type === 'tool_call_complete');
      if (completedB?.type !== 'tool_call_complete') {
        throw new Error('missing late authoritative serial sibling');
      }
      expect(JSON.parse(completedB.call.function.arguments)).toEqual({ value: 'B' });

      // Then: B also resumes on the original Run.
      const final = collect(cursor, {
        ...request,
        messages: [
          ...historyAfterA,
          { role: 'assistant', content: '', tool_calls: [completedB.call] },
          { role: 'tool', tool_call_id: completedB.call.id, content: 'result-B' },
        ],
      });
      run.stream.emit(
        'data',
        Buffer.concat([
          update('textDelta', { text: 'late serial continued' }),
          update('turnEnded', { inputTokens: 4, outputTokens: 2 }),
          trailer(),
        ]),
      );
      expect(await final).toContainEqual({ type: 'content', text: 'late serial continued' });
      expect(transport.opened).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for a started sibling mcpArgs instead of closing with a dangling partial', async () => {
    // Given: call A completes, the settle window expires, and only then is
    // call B announced (start + partial args) with its completing mcpArgs
    // arriving one window later.
    const request = parallelToolRequest();
    const wireName = wireToolName(request);
    const transport = new ScriptedTransport((stream) => {
      stream.emit('response', { ':status': 200 });
      stream.emit('data', callBatch(wireName, 'call-a', 'A'));
      setTimeout(() => {
        stream.emit(
          'data',
          Buffer.concat([
            update('toolCallStarted', {
              callId: 'call-b',
              toolCall: {
                tool: {
                  case: 'mcpToolCall',
                  value: {
                    args: {
                      name: wireName,
                      toolName: wireName,
                      providerIdentifier: 'bridge',
                      toolCallId: 'call-b',
                      args: {},
                    },
                  },
                },
                toolCallId: 'call-b',
              },
            }),
            update('partialToolCall', { callId: 'call-b', argsTextDelta: '{"value":"B"}' }),
          ]),
        );
      }, 30);
      setTimeout(() => {
        stream.emit(
          'data',
          Buffer.concat([
            // mcpArgs for B arrives after the first settle window passed.
            callBatch(wireName, 'call-b', 'B'),
            update('turnEnded', { inputTokens: 2, outputTokens: 2 }),
            trailer(),
          ]),
        );
      }, 120);
    });

    // When: the client consumes the stream.
    const events = await collect(
      backend(transport, undefined, { CURSOR_BRIDGE_STICKY_SETTLE_MS: '50' }),
      request,
    );

    // Then: one response, both calls completed — no dangling partial B.
    expect(completedValues(events)).toEqual(['A', 'B']);
    expect(events.at(-1)?.type).toBe('done');
  });
});
