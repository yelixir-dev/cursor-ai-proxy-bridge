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

describe('cursor-api sticky hold with an incomplete sibling', () => {
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
