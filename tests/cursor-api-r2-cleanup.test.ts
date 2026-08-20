import { describe, expect, it } from 'vitest';
import type { CompletionStreamEvent } from '../src/backend/types.js';
import {
  backend,
  callBatch,
  parallelToolRequest,
  ScriptedTransport,
  toolCall,
  update,
  wireToolName,
} from './support/cursor-api-scripted.js';

describe('cursor-api Run cleanup', () => {
  it('surfaces an upstream error while a completed batch waits for its boundary', async () => {
    // Given: call A completed but no turn or stream boundary arrived.
    const request = parallelToolRequest();
    const wireName = wireToolName(request);
    const transport = new ScriptedTransport((stream) => {
      stream.emit('response', { ':status': 200 });
      stream.emit('data', callBatch(wireName, 'call-a', 'A'));
      stream.destroy(Object.assign(new Error('upstream reset'), { code: 'ECONNRESET' }));
    });
    const events: CompletionStreamEvent[] = [];
    let failure: unknown;

    // When: the upstream stream fails before the authoritative boundary.
    try {
      for await (const event of backend(transport).completeStream(request)) events.push(event);
    } catch (error) {
      failure = error;
    }

    // Then: the failure is surfaced, the stream is destroyed, and no successful
    // completion or terminal event is fabricated.
    expect(failure).toMatchObject({ message: 'upstream reset' });
    expect(events.map((event) => event.type)).toEqual([
      'tool_call_start',
      'tool_call_arguments_delta',
    ]);
    expect(transport.opened[0]?.stream.destroyed).toBe(true);
    expect(transport.attempts).toEqual(['only-token']);
  });

  it('aborts a pending parallel batch, destroys the stream, and surfaces no terminal', async () => {
    // Given: call A completed and call B is announced but incomplete.
    const request = parallelToolRequest();
    const wireName = wireToolName(request);
    const transport = new ScriptedTransport((stream) => {
      stream.emit('response', { ':status': 200 });
      stream.emit('data', callBatch(wireName, 'call-a', 'A'));
      stream.emit(
        'data',
        update('toolCallStarted', {
          callId: 'call-b',
          toolCall: {
            tool: { case: 'mcpToolCall', value: { args: toolCall(wireName, 'call-b', '') } },
            toolCallId: 'call-b',
          },
        }),
      );
    });
    const controller = new AbortController();
    const cursor = backend(transport);
    const iterator = cursor.completeStream(request, controller.signal)[Symbol.asyncIterator]();
    const firstEvent = iterator.next();
    const run = await transport.firstRun;
    await firstEvent;

    // When: the caller aborts while the batch is still pending.
    controller.abort();
    const lateEvents: CompletionStreamEvent[] = [];
    await expect(
      (async () => {
        for (;;) {
          const result = await iterator.next();
          if (result.done) return;
          lateEvents.push(result.value);
        }
      })(),
    ).rejects.toMatchObject({ name: 'AbortError' });

    // Then: the stream is destroyed, no terminal event is emitted, and a later
    // delivery produces no further client event after the abort.
    run.stream.emit('data', callBatch(wireName, 'call-b', 'B'));
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    expect(run.stream.destroyed).toBe(true);
    expect(lateEvents.map((event) => event.type)).not.toContain('done');
    expect(lateEvents.map((event) => event.type)).not.toContain('tool_call_complete');
    expect(transport.attempts).toEqual(['only-token']);
  });
});
