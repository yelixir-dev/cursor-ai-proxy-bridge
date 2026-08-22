import { describe, expect, it } from 'vitest';
import { CursorCommandAbortedError } from '../src/backend/cursor-cli.js';
import { CursorCredentialRouter } from '../src/backend/cursor-api/credentials.js';
import { jsonToProtoValue } from '../src/backend/cursor-api/protobuf.js';
import type { CursorApiTransport } from '../src/backend/cursor-api/transport.js';
import type { ChatCompletionRequest, CompletionStreamEvent } from '../src/backend/types.js';
import {
  backend,
  callBatch,
  collect,
  compressedUpdate,
  mcpArgsFrame,
  parallelToolRequest,
  ScriptedTransport,
  trailer,
  update,
  wireToolName,
} from './support/cursor-api-scripted.js';

async function collectWithSignal(
  cursor: ReturnType<typeof backend>,
  request: ChatCompletionRequest,
  signal: AbortSignal,
): Promise<CompletionStreamEvent[]> {
  const events: CompletionStreamEvent[] = [];
  for await (const event of cursor.completeStream(request, signal)) events.push(event);
  return events;
}

describe('cursor-api sticky Run isolation', () => {
  it('releases a parked Run when surfaced tool arguments fail validation', async () => {
    // Given: mcpArgs completes a call whose value violates the declared
    // string schema, after which the native Run would otherwise stay parked.
    const request = { ...parallelToolRequest(), parallel_tool_calls: false };
    const wireName = wireToolName(request);
    const transport = new ScriptedTransport((stream) => {
      stream.emit('response', { ':status': 200 });
      stream.emit(
        'data',
        mcpArgsFrame({
          name: wireName,
          toolName: wireName,
          providerIdentifier: 'bridge',
          toolCallId: 'call-invalid',
          args: { value: jsonToProtoValue(123) },
        }),
      );
    });
    const cursor = backend(transport);

    // When: post-run schema validation rejects the surfaced call.
    await expect(collect(cursor, request)).rejects.toThrow('arguments failed schema validation');

    // Then: the hold cannot remain resumable after its client response failed.
    const run = await transport.firstRun;
    expect(run.stream.destroyed || run.stream.writableEnded).toBe(true);
    await cursor.shutdown();
  });

  it('cleans up when abort wins the openRun setup race', async () => {
    // Given: transport openRun has started but has not returned its stream.
    const openStarted = Promise.withResolvers<void>();
    const releaseOpen = Promise.withResolvers<void>();
    const baseTransport = new ScriptedTransport((stream) => {
      stream.emit('response', { ':status': 200 });
    });
    const delayedTransport: CursorApiTransport = {
      unary: (path) => baseTransport.unary(path),
      openRun: async (baseUrl, requestId, accessToken) => {
        openStarted.resolve();
        await releaseOpen.promise;
        return baseTransport.openRun(baseUrl, requestId, accessToken);
      },
    };
    const cursor = backend(delayedTransport);
    const controller = new AbortController();
    const completion = cursor.complete(
      {
        model: 'composer-2.5',
        messages: [{ role: 'user', content: 'abort during open' }],
      },
      controller.signal,
    );
    await openStarted.promise;

    // When: cancellation wins immediately before openRun returns.
    controller.abort();
    releaseOpen.resolve();

    // Then: setup rejects with the typed abort and closes the just-opened
    // stream without touching timer bindings that do not exist yet.
    await expect(completion).rejects.toBeInstanceOf(CursorCommandAbortedError);
    const opened = baseTransport.opened[0];
    if (!opened) throw new Error('delayed transport never returned a stream');
    expect(opened.stream.writableEnded || opened.stream.destroyed).toBe(true);
  });

  it('bounds cumulative decoded bytes during active processing', async () => {
    // Given: each compressed frame is individually below the limit while
    // their decoded text retained by one active Run exceeds it in aggregate.
    const transport = new ScriptedTransport((stream) => {
      stream.emit('response', { ':status': 200 });
      stream.emit(
        'data',
        Buffer.concat([
          compressedUpdate('textDelta', { text: 'x'.repeat(700) }),
          compressedUpdate('textDelta', { text: 'y'.repeat(700) }),
          update('turnEnded', { inputTokens: 2, outputTokens: 2 }),
          trailer(),
        ]),
      );
    });
    const cursor = backend(transport, undefined, {
      CURSOR_BRIDGE_MAX_OUTPUT_BYTES: '1024',
    });

    // When/Then: the Run-level decoded total, not only each frame and wire
    // chunk, owns the configured output boundary.
    await expect(
      cursor.complete({
        model: 'composer-2.5',
        messages: [{ role: 'user', content: 'return bounded text' }],
      }),
    ).rejects.toThrow('decoded payload exceeds 1024 bytes');
  });

  it('bounds cumulative decoded bytes retained while parked', async () => {
    // Given: one call parks the Run under a limit that each compressed frame
    // satisfies independently.
    const request = { ...parallelToolRequest(), parallel_tool_calls: false };
    const wireName = wireToolName(request);
    const transport = new ScriptedTransport((stream) => {
      stream.emit('response', { ':status': 200 });
      stream.emit('data', callBatch(wireName, 'call-a', 'A'));
    });
    const cursor = backend(transport, undefined, {
      CURSOR_BRIDGE_MAX_OUTPUT_BYTES: '1024',
    });
    await collect(cursor, request);
    const run = await transport.firstRun;
    const compressed = Buffer.concat([
      compressedUpdate('textDelta', { text: 'x'.repeat(600) }),
      compressedUpdate('textDelta', { text: 'y'.repeat(600) }),
    ]);
    expect(compressed.length).toBeLessThan(512);

    // When: multiple small wire frames expand beyond the aggregate parked
    // memory budget.
    run.stream.emit('data', compressed);

    // Then: aggregate decoded retention, not only wire size or per-frame
    // expansion, releases the held Run.
    expect(run.stream.destroyed).toBe(true);
  });

  it('namespaces identical native tool ids across concurrent Runs', async () => {
    // Given: two concurrent-looking Runs emit the same native tool id for the
    // same request shape, which cannot safely be used as a global store key.
    const request = {
      ...parallelToolRequest(),
      parallel_tool_calls: false,
      messages: [{ role: 'user' as const, content: 'same prompt' }],
    };
    const wireName = wireToolName(request);
    const transport = new ScriptedTransport((stream) => {
      stream.emit('response', { ':status': 200 });
      const value = transport.opened.length === 1 ? 'A' : 'B';
      stream.emit('data', callBatch(wireName, 'call-shared', value));
    });
    const cursor = backend(transport, [
      { id: 'first', apiKey: 'first-token' },
      { id: 'second', apiKey: 'second-token' },
    ]);
    const firstA = await collect(cursor, request);
    const firstB = await collect(cursor, request);
    const callA = firstA.find((event) => event.type === 'tool_call_complete');
    const callB = firstB.find((event) => event.type === 'tool_call_complete');
    if (callA?.type !== 'tool_call_complete' || callB?.type !== 'tool_call_complete') {
      throw new Error('missing duplicate-id tool calls');
    }

    // Then: client-visible opaque ids carry distinct Run namespaces even
    // though both upstream calls used call-shared.
    expect(callA.call.id).not.toBe(callB.call.id);

    // And: each result resumes only its own original stream.
    const runA = transport.opened[0];
    const runB = transport.opened[1];
    if (!runA || !runB) throw new Error('missing duplicate-id Runs');
    const wroteA = Promise.withResolvers<void>();
    const wroteB = Promise.withResolvers<void>();
    runA.stream.once('write', () => wroteA.resolve());
    runB.stream.once('write', () => wroteB.resolve());
    const continuationA = collect(cursor, {
      ...request,
      messages: [
        ...request.messages,
        { role: 'assistant', content: '', tool_calls: [callA.call] },
        { role: 'tool', tool_call_id: callA.call.id, content: 'result-A' },
      ],
    });
    const continuationB = collect(cursor, {
      ...request,
      messages: [
        ...request.messages,
        { role: 'assistant', content: '', tool_calls: [callB.call] },
        { role: 'tool', tool_call_id: callB.call.id, content: 'result-B' },
      ],
    });
    await Promise.all([wroteA.promise, wroteB.promise]);
    runA.stream.emit(
      'data',
      Buffer.concat([
        update('textDelta', { text: 'continued A' }),
        update('turnEnded', { inputTokens: 2, outputTokens: 1 }),
        trailer(),
      ]),
    );
    runB.stream.emit(
      'data',
      Buffer.concat([
        update('textDelta', { text: 'continued B' }),
        update('turnEnded', { inputTokens: 2, outputTokens: 1 }),
        trailer(),
      ]),
    );
    expect(await continuationA).toContainEqual({ type: 'content', text: 'continued A' });
    expect(await continuationB).toContainEqual({ type: 'content', text: 'continued B' });
    expect(transport.opened).toHaveLength(2);
  });

  it('resumes a held Run without selecting a different credential', async () => {
    // Given: weighted routing has two credentials and request 1 parks a Run
    // opened under the first credential.
    const request = { ...parallelToolRequest(), parallel_tool_calls: false };
    const wireName = wireToolName(request);
    const credentials = [
      { id: 'first', apiKey: 'first-token' },
      { id: 'second', apiKey: 'second-token' },
    ];
    const router = new CursorCredentialRouter({ credentials });
    const transport = new ScriptedTransport((stream) => {
      stream.emit('response', { ':status': 200 });
      stream.emit('data', callBatch(wireName, 'call-a', 'A'));
    });
    const cursor = backend(transport, credentials, {}, router);
    const first = await collect(cursor, request);
    const call = first.find((event) => event.type === 'tool_call_complete');
    if (call?.type !== 'tool_call_complete') throw new Error('missing credential-held call');
    expect(router.snapshot().map((state) => state.routerPicks)).toEqual([1, 0]);

    // When: request 2 returns the tool result for the already-authenticated
    // native stream.
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
        update('textDelta', { text: 'credential continued' }),
        update('turnEnded', { inputTokens: 2, outputTokens: 1 }),
        trailer(),
      ]),
    );
    await continuation;

    // Then: continuation affinity is the held stream itself; the router does
    // not lease the unrelated second credential.
    expect(router.snapshot().map((state) => state.routerPicks)).toEqual([1, 0]);
    expect(transport.attempts).toEqual(['first-token']);
  });

  it('enforces the output byte limit while a Run is parked', async () => {
    // Given: a Run is parked after a normal-sized tool call.
    const request = { ...parallelToolRequest(), parallel_tool_calls: false };
    const wireName = wireToolName(request);
    const transport = new ScriptedTransport((stream) => {
      stream.emit('response', { ':status': 200 });
      stream.emit('data', callBatch(wireName, 'call-a', 'A'));
    });
    const cursor = backend(transport, undefined, {
      CURSOR_BRIDGE_MAX_OUTPUT_BYTES: '512',
    });
    await collect(cursor, request);
    const run = await transport.firstRun;
    expect(run.stream.destroyed).toBe(false);

    // When: upstream continues producing more than the configured limit while
    // no OpenAI request is actively consuming the held Run.
    run.stream.emit('data', update('textDelta', { text: 'x'.repeat(1_024) }));

    // Then: the parked stream is released immediately instead of retaining an
    // unbounded decoded-frame queue until the Run timeout.
    expect(run.stream.destroyed).toBe(true);
  });

  it('aborting one parked Run does not release another parked Run', async () => {
    // Given: two independent requests have parked two native Runs.
    const base = { ...parallelToolRequest(), parallel_tool_calls: false };
    const requestA = { ...base, messages: [{ role: 'user' as const, content: 'call A' }] };
    const requestB = { ...base, messages: [{ role: 'user' as const, content: 'call B' }] };
    const wireName = wireToolName(base);
    const replacementOpened = Promise.withResolvers<'replacement'>();
    const transport = new ScriptedTransport((stream) => {
      stream.emit('response', { ':status': 200 });
      const index = transport.opened.length;
      if (index === 1) stream.emit('data', callBatch(wireName, 'call-a', 'A'));
      else if (index === 2) stream.emit('data', callBatch(wireName, 'call-b', 'B'));
      else {
        replacementOpened.resolve('replacement');
        stream.emit(
          'data',
          Buffer.concat([
            update('textDelta', { text: 'unexpected replacement' }),
            update('turnEnded', { inputTokens: 1, outputTokens: 1 }),
            trailer(),
          ]),
        );
      }
    });
    const cursor = backend(transport);
    const controllerA = new AbortController();
    const controllerB = new AbortController();
    try {
      const firstA = await collectWithSignal(cursor, requestA, controllerA.signal);
      const firstB = await collectWithSignal(cursor, requestB, controllerB.signal);
      const callB = firstB.find((event) => event.type === 'tool_call_complete');
      expect(firstA.some((event) => event.type === 'tool_call_complete')).toBe(true);
      if (callB?.type !== 'tool_call_complete') throw new Error('missing isolated call B');

      // When: only request A is cancelled after both Runs are parked.
      controllerA.abort();
      await Promise.resolve();

      // Then: B still resumes its original stream rather than opening a
      // replacement because another Run was globally cleared.
      const runB = transport.opened[1];
      if (!runB) throw new Error('missing second native Run');
      const resultWritten = Promise.withResolvers<'resumed'>();
      runB.stream.once('write', () => resultWritten.resolve('resumed'));
      const followUp = collect(cursor, {
        ...requestB,
        messages: [
          ...requestB.messages,
          { role: 'assistant', content: '', tool_calls: [callB.call] },
          { role: 'tool', tool_call_id: callB.call.id, content: 'result-B' },
        ],
      });
      const route = await Promise.race([resultWritten.promise, replacementOpened.promise]);
      if (route === 'resumed') {
        runB.stream.emit(
          'data',
          Buffer.concat([
            update('textDelta', { text: 'continued B' }),
            update('turnEnded', { inputTokens: 2, outputTokens: 1 }),
            trailer(),
          ]),
        );
      }
      const events = await followUp;
      expect(route).toBe('resumed');
      expect(events).toContainEqual({ type: 'content', text: 'continued B' });
      expect(transport.opened).toHaveLength(2);
    } finally {
      controllerA.abort();
      controllerB.abort();
    }
  });
});
