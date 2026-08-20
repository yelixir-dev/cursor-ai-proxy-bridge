import { describe, expect, it } from 'vitest';
import { ToolArgumentValidationError } from '../src/backend/tool-arguments.js';
import type { ChatCompletionRequest, CompletionStreamEvent } from '../src/backend/types.js';
import {
  backend,
  collect,
  type ScriptedStream,
  ScriptedTransport,
  trailer,
  update,
} from './support/cursor-api-scripted.js';

describe('cursor-api request-scoped validation replay boundary', () => {
  const toolRequest: ChatCompletionRequest = {
    model: 'composer-2.5',
    messages: [{ role: 'user', content: 'call echo' }],
    tools: [
      {
        type: 'function',
        function: {
          name: 'echo_value',
          parameters: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
          },
        },
      },
    ],
    tool_choice: 'auto',
  };
  const invalidMarker =
    '[TOOL_CALLS: [{"function":{"name":"echo_value","arguments":{"value":123}}}]]';
  const validMarker =
    '[TOOL_CALLS: [{"function":{"name":"echo_value","arguments":{"value":"FIXED"}}}]]';

  function markerRun(text: string): (stream: ScriptedStream) => void {
    return (stream) => {
      stream.emit('response', { ':status': 200 });
      stream.emit(
        'data',
        Buffer.concat([
          update('textDelta', { text }),
          update('turnEnded', { inputTokens: 3, outputTokens: 2 }),
          trailer(),
        ]),
      );
    };
  }

  it('fails the current request after visible content instead of replaying under another credential', async () => {
    // Given: the first credential delivers visible prose and then a buffered
    // hidden tool marker whose recovered arguments are schema-invalid.
    const transport = new ScriptedTransport(markerRun(`VISIBLE_PROSE ${invalidMarker}`));
    const cursor = backend(transport, [
      { id: 'first', apiKey: 'first-token' },
      { id: 'second', apiKey: 'second-token' },
    ]);
    const events: CompletionStreamEvent[] = [];
    let failure: unknown;
    try {
      for await (const event of cursor.completeStream(toolRequest)) events.push(event);
    } catch (error) {
      failure = error;
    }

    // Then: exactly one Run under one credential, no second upstream Run, the
    // visible content stays delivered, and a typed validation error surfaces.
    expect(failure).toBeInstanceOf(ToolArgumentValidationError);
    expect(events).toEqual([{ type: 'content', text: 'VISIBLE_PROSE ' }]);
    expect(transport.attempts).toEqual(['first-token']);
  });

  it('routes a later request to another credential after a visible validation failure', async () => {
    // Given: a request failed after visible output, and two credentials exist.
    const scripts = new Map<string, (stream: ScriptedStream) => void>([
      ['first-token', markerRun(`VISIBLE_PROSE ${invalidMarker}`)],
      [
        'second-token',
        (stream) => {
          stream.emit('response', { ':status': 200 });
          stream.emit(
            'data',
            Buffer.concat([
              update('textDelta', { text: 'SECOND_REQUEST_OK' }),
              update('turnEnded', { inputTokens: 4, outputTokens: 2 }),
              trailer(),
            ]),
          );
        },
      ],
    ]);
    const transport = new ScriptedTransport((stream, accessToken) => {
      const script = scripts.get(accessToken);
      if (!script) throw new Error(`unexpected credential ${accessToken}`);
      script(stream);
    });
    const cursor = backend(transport, [
      { id: 'first', apiKey: 'first-token' },
      { id: 'second', apiKey: 'second-token' },
    ]);
    await expect(collect(cursor, toolRequest)).rejects.toBeInstanceOf(ToolArgumentValidationError);

    // When: the next request arrives.
    const next = await collect(cursor, toolRequest);

    // Then: it may fail over to the other credential and complete.
    expect(next.filter((event) => event.type === 'content')).toEqual([
      { type: 'content', text: 'SECOND_REQUEST_OK' },
    ]);
    expect(transport.attempts).toEqual(['first-token', 'second-token']);
  });

  it('still retries a buffered validation correction before any visible output', async () => {
    // Given: the first Run exposes nothing visible (the marker is suppressed)
    // and recovers schema-invalid arguments; the corrected Run is valid.
    const scripts = [markerRun(invalidMarker), markerRun(validMarker)] as const;
    let opens = 0;
    const transport = new ScriptedTransport((stream) => {
      const script = scripts[Math.min(opens, scripts.length - 1)];
      if (!script) throw new Error('missing Run script');
      opens += 1;
      script(stream);
    });

    // When: the client consumes the stream.
    const events = await collect(backend(transport), toolRequest);

    // Then: the pre-visible correction retry is bounded to one extra Run and
    // returns the corrected call.
    expect(opens).toBe(2);
    expect(events.filter((event) => event.type === 'tool_call_complete')).toEqual([
      {
        type: 'tool_call_complete',
        index: 0,
        call: {
          id: expect.any(String),
          type: 'function',
          function: { name: 'echo_value', arguments: '{"value":"FIXED"}' },
        },
      },
    ]);
    expect(events.filter((event) => event.type === 'content')).toEqual([]);
  });
});
