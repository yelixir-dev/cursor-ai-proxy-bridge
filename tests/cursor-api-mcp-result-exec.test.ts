import { describe, expect, it } from 'vitest';
import { ConnectFrameDecoder } from '../src/backend/cursor-api/connect-frame.js';
import { loadProtoDescriptors, ProtoCodec } from '../src/backend/cursor-api/protobuf.js';
import {
  backend,
  callBatch,
  collect,
  mcpArgsFrame,
  parallelToolRequest,
  ScriptedTransport,
  trailer,
  toolCall,
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
  it('writes an execClientMessage mcpResult success after an allowed mcpArgs', async () => {
    // Given: upstream asks the bridge to execute an advertised MCP tool.
    const request = parallelToolRequest();
    const wireName = wireToolName(request);
    const transport = scriptedMcpArgsRun([callBatch(wireName, 'call-a', 'A')]);

    // When: the Run consumes that mcpArgs frame.
    await collect(backend(transport), request);

    // Then: the same Run writes mcpResult success upstream (the missing stall answer).
    const results = mcpResultMessages(decodeExecClientMessages(runWrites(transport)));
    expect(results).toHaveLength(1);
    const answered = results[0];
    if (!answered) throw new Error('expected mcpResult answer');
    expect(mcpResultCase(answered)).toBe('success');
  });

  it('echoes the server exec id without execId and keeps OpenAI tool_calls', async () => {
    // Given: mcpArgs carries a non-default exec id plus a server execId.
    const request = parallelToolRequest();
    const wireName = wireToolName(request);
    const transport = scriptedMcpArgsRun([
      update('toolCallStarted', {
        callId: 'call-a',
        toolCall: {
          tool: { case: 'mcpToolCall', value: { args: toolCall(wireName, 'call-a', '') } },
          toolCallId: 'call-a',
        },
      }),
      update('partialToolCall', { callId: 'call-a', argsTextDelta: '{"value":"A"}' }),
      mcpArgsFrame(toolCall(wireName, 'call-a', 'A'), 17, 'server-exec-id'),
    ]);

    // When: the client consumes the stream.
    const events = await collect(backend(transport), request);

    // Then: the answer echoes id 17, omits execId, and OpenAI tool_calls still emit.
    const result = mcpResultMessages(decodeExecClientMessages(runWrites(transport)))[0];
    if (!result) throw new Error('expected mcpResult answer');
    expect(result.id).toBe(17);
    expect(Object.hasOwn(result, 'execId')).toBe(false);
    expect(mcpResultCase(result)).toBe('success');
    expect(
      events.flatMap((event) => (event.type === 'tool_call_complete' ? [event.call] : [])),
    ).toEqual([
      {
        id: 'call-a',
        type: 'function',
        function: { name: 'echo_value', arguments: '{"value":"A"}' },
      },
    ]);
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

    // Then: no success is claimed on the exec channel, and the stream still settles.
    const results = mcpResultMessages(decodeExecClientMessages(runWrites(transport)));
    expect(results.filter((exec) => mcpResultCase(exec) === 'success')).toEqual([]);
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

    // Then: typed handling yields no success claim and a normal terminal.
    const results = mcpResultMessages(decodeExecClientMessages(runWrites(transport)));
    expect(results.filter((exec) => mcpResultCase(exec) === 'success')).toEqual([]);
    expect(events.filter((event) => event.type === 'tool_call_complete')).toEqual([]);
    expect(events.at(-1)?.type).toBe('done');
  });
});
