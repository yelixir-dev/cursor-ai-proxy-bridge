import { describe, expect, it } from 'vitest';
import { ConnectFrameDecoder } from '../src/backend/cursor-api/connect-frame.js';
import { loadProtoDescriptors, ProtoCodec } from '../src/backend/cursor-api/protobuf.js';
import type { ChatCompletionRequest } from '../src/backend/types.js';
import {
  backend,
  callBatch,
  collect,
  mcpArgsFrame,
  parallelToolRequest,
  ScriptedTransport,
  trailer,
  update,
  wireToolName,
} from './support/cursor-api-scripted.js';

const codec = new ProtoCodec(loadProtoDescriptors());

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return Object.fromEntries(Object.entries(value));
}

function decodeExecClientMessages(writes: readonly Buffer[]): Array<Record<string, unknown>> {
  const decoder = new ConnectFrameDecoder();
  const messages: Array<Record<string, unknown>> = [];
  for (const write of writes) {
    for (const frame of decoder.push(write)) {
      if (!frame.payload) continue;
      const decoded = objectRecord(
        codec.decode('agent.v1.AgentClientMessage', frame.payload),
        'AgentClientMessage',
      );
      const message = objectRecord(decoded.message, 'message');
      if (message.case !== 'execClientMessage') continue;
      messages.push(objectRecord(message.value, 'execClientMessage'));
    }
  }
  return messages;
}

function mcpResultMessages(
  execs: readonly Record<string, unknown>[],
): Array<Record<string, unknown>> {
  return execs.filter(
    (exec) => objectRecord(exec.message, 'execClientMessage.message').case === 'mcpResult',
  );
}

function mcpResultCase(exec: Record<string, unknown>): string {
  const message = objectRecord(exec.message, 'execClientMessage.message');
  const value = objectRecord(message.value, 'mcpResult');
  return String(objectRecord(value.result, 'mcpResult.result').case ?? '');
}

function runWrites(transport: ScriptedTransport): Buffer[] {
  const run = transport.opened[0];
  if (!run) throw new Error('expected an opened Run');
  return run.stream.writes;
}

function scriptedMcpArgsRun(frames: Buffer[]): ScriptedTransport {
  return new ScriptedTransport((stream) => {
    stream.emit('response', { ':status': 200 });
    stream.emit(
      'data',
      Buffer.concat([
        ...frames,
        update('turnEnded', { inputTokens: 1, outputTokens: 1 }),
        trailer(),
      ]),
    );
  });
}

describe('cursor-api mcpArgs exec answer', () => {
  it('holds the Run on mcpArgs without answering and surfaces the call to OpenAI', async () => {
    // Given: upstream asks the bridge to execute an advertised MCP tool in a
    // request whose history carries no tool results yet.
    const request = parallelToolRequest();
    const wireName = wireToolName(request);
    const transport = new ScriptedTransport((stream) => {
      stream.emit('response', { ':status': 200 });
      stream.emit('data', callBatch(wireName, 'call-a', 'A'));
    });

    // When: the sticky settle window elapses with no further execs.
    const events = await collect(backend(transport), request);

    // Then: no mcpResult is sent (the client owns execution), the call is
    // handed to OpenAI, and the Run stays parked for the next request.
    const results = mcpResultMessages(decodeExecClientMessages(runWrites(transport)));
    expect(results).toEqual([]);
    expect(
      events.filter((event) => event.type === 'tool_call_complete').map((event) => event.call),
    ).toEqual([
      {
        id: 'call-a',
        type: 'function',
        function: { name: 'echo_value', arguments: '{"value":"A"}' },
      },
    ]);
    expect(events.at(-1)?.type).toBe('done');
  });

  it('resumes a held Run with the client tool result on the same stream', async () => {
    // Given: request 1 parked on mcpArgs for call-a and returned it to OpenAI.
    const request = parallelToolRequest();
    const wireName = wireToolName(request);
    const transport = new ScriptedTransport((stream) => {
      stream.emit('response', { ':status': 200 });
      stream.emit('data', callBatch(wireName, 'call-a', 'A'));
    });
    const cursor = backend(transport);
    const first = await collect(cursor, request);
    expect(first.at(-1)?.type).toBe('done');

    // When: request 2 carries the tool result and, once answered in band, the
    // model continues with text and ends the turn.
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
    const secondPromise = collect(cursor, followUp);
    const run = await transport.firstRun;
    run.stream.emit(
      'data',
      Buffer.concat([
        update('textDelta', { text: 'used result-A' }),
        update('turnEnded', { inputTokens: 4, outputTokens: 2 }),
        trailer(),
      ]),
    );
    const second = await secondPromise;

    // Then: the result went over the same Run as a populated mcpResult and
    // the continuation text reached the second OpenAI response.
    const results = mcpResultMessages(decodeExecClientMessages(runWrites(transport)));
    expect(results).toHaveLength(1);
    expect(mcpResultCase(results[0] ?? {})).toBe('success');
    const resultWire = JSON.stringify(results[0]);
    expect(resultWire).toContain('result-A');
    expect(
      second.some((event) => event.type === 'content' && event.text.includes('used result-A')),
    ).toBe(true);
    expect(second.at(-1)?.type).toBe('done');
  });

  it('does not claim mcpResult success for an unknown tool name and does not crash', async () => {
    // Given: upstream mcpArgs names a tool the request never advertised.
    const request = parallelToolRequest();
    const transport = scriptedMcpArgsRun([
      mcpArgsFrame({
        name: 'not_a_bridge_tool',
        toolName: 'not_a_bridge_tool',
        providerIdentifier: 'bridge',
        toolCallId: 'call-unknown',
        args: { value: { kind: { case: 'stringValue', value: 'nope' } } },
      }),
    ]);

    // When: the Run handles the unknown tool exec.
    const events = await collect(backend(transport), request);

    // Then: no success is claimed, the exec is answered with a typed error so
    // upstream fails fast instead of stalling, and the stream still settles.
    const results = mcpResultMessages(decodeExecClientMessages(runWrites(transport)));
    expect(results.filter((exec) => mcpResultCase(exec) === 'success')).toEqual([]);
    expect(results.filter((exec) => mcpResultCase(exec) === 'error')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'tool_call_complete')).toEqual([]);
    expect(events.at(-1)?.type).toBe('done');
  });

  it('handles malformed mcpArgs fields without crashing or claiming success', async () => {
    // Given: mcpArgs is missing names, has a non-object args map, and a non-string id.
    const request = parallelToolRequest();
    const transport = scriptedMcpArgsRun([
      mcpArgsFrame({
        name: 42,
        toolName: { nested: true },
        toolCallId: ['not-a-string'],
        args: 'not-a-map',
      }),
    ]);

    // When: the Run decodes that exec.
    const events = await collect(backend(transport), request);

    // Then: typed error handling answers the exec, claims no success, and
    // the stream reaches a normal terminal.
    const results = mcpResultMessages(decodeExecClientMessages(runWrites(transport)));
    expect(results.filter((exec) => mcpResultCase(exec) === 'success')).toEqual([]);
    expect(results.filter((exec) => mcpResultCase(exec) === 'error')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'tool_call_complete')).toEqual([]);
    expect(events.at(-1)?.type).toBe('done');
  });
});
