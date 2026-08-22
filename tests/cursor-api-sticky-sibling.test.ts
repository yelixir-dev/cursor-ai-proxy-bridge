import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_STICKY_SETTLE_MS } from '../src/backend/cursor-api/run-execution.js';
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

describe('cursor-api sticky hold with an incomplete sibling', () => {
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
      expect(
        firstEvents
          .filter((event) => event.type === 'tool_call_complete')
          .map((event) => event.call.id),
      ).toEqual(['call-a']);
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
      expect(
        secondEvents
          .filter((event) => event.type === 'tool_call_complete')
          .map((event) => event.call.id),
      ).toEqual(['call-b']);
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
      expect(
        events.filter((event) => event.type === 'tool_call_complete').map((event) => event.call.id),
      ).toEqual(['call-a', 'call-b']);
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
      expect(
        events.filter((event) => event.type === 'tool_call_complete').map((event) => event.call.id),
      ).toEqual(['call-a', 'call-b']);
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
      expect(completedB.call.id).toBe('call-b');

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
      expect(completedB.call.id).toBe('call-b');

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
    expect(
      events.filter((event) => event.type === 'tool_call_complete').map((event) => event.call.id),
    ).toEqual(['call-a', 'call-b']);
    expect(events.at(-1)?.type).toBe('done');
  });
});
