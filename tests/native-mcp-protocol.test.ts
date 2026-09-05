import assert from 'node:assert/strict';
import { describe, expect, it, vi } from 'vitest';
import {
  handleExecResponse,
  sendHeldToolResult,
} from '../src/backend/cursor-api/exec-responses.js';
import type { HeldToolExec } from '../src/backend/cursor-api/exec-responses.js';
import { buildCursorHistory } from '../src/backend/cursor-api/history.js';
import { nativeToolDefinition, requestContextResult } from '../src/backend/cursor-api/mapper.js';
import { mcpArgsToToolCall } from '../src/backend/cursor-api/mcp-tool-call.js';
import {
  jsonToProtoValue,
  loadProtoDescriptors,
  ProtoCodec,
  protoValueToJson,
} from '../src/backend/cursor-api/protobuf.js';
import { CursorRunMessages } from '../src/backend/cursor-api/run-messages.js';
import { mapCursorApiToolRequest } from '../src/backend/cursor-api/tool-wire-names.js';
import type { ChatCompletionRequest, CompletionStreamEvent } from '../src/backend/types.js';

import { arrayAt, objectAt, valueAt } from './support/protobuf-values.js';

const codec = new ProtoCodec(loadProtoDescriptors());
function required<T>(value: T | undefined): T {
  assert.ok(value !== undefined, 'Expected fixture value');
  return value;
}
const schema = {
  type: 'object',
  properties: {
    value: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    nested: { type: 'array', items: { type: 'boolean' } },
  },
  required: ['value'],
  additionalProperties: false,
};
function request(name = 'echo_value'): ChatCompletionRequest {
  return {
    model: 'composer-2.5',
    messages: [
      { role: 'system', content: 'caller-system' },
      { role: 'developer', content: 'caller-developer' },
      { role: 'user', content: 'call echo' },
    ],
    tools: [
      { type: 'function', function: { name, description: 'Echo a value', parameters: schema } },
    ],
    tool_choice: 'auto',
    max_tool_calls: 1,
    parallel_tool_calls: false,
  };
}
function roundTrip(message: Record<string, unknown>) {
  return codec.decode(
    'agent.v1.AgentClientMessage',
    codec.encode('agent.v1.AgentClientMessage', message),
  );
}
function nativeArgs() {
  return {
    name: 'bridge-echo_value',
    toolName: 'echo_value',
    providerIdentifier: 'bridge',
    serverIdentifier: 'bridge',
    toolCallId: 'native-call',
    args: { value: jsonToProtoValue(null), nested: jsonToProtoValue([true, false]) },
  };
}

describe('pinned native slim MCP profile', () => {
  it('uses literal server-prefixed identities without sanitization or truncation', () => {
    const names = ['Shell', 'a.b', 'a/b', 'a_b', 'bridge-echo_value', 'x'.repeat(160)];
    const source = request();
    source.tools = names.map((name) => ({ type: 'function', function: { name } }));
    const mapped = mapCursorApiToolRequest(source);
    expect(mapped.request.tools?.map((tool) => tool.function.name)).toEqual(
      names.map((name) => `bridge-${name}`),
    );
    for (const name of names) expect(mapped.restoreToolName(`bridge-${name}`)).toBe(name);
  });

  it('keeps auto optional and preserves only caller root messages', () => {
    const source = request();
    const mapped = mapCursorApiToolRequest(source).request;
    expect(mapped.tool_choice).toBe('auto');
    expect(mapped.messages).toEqual(source.messages);
    const history = buildCursorHistory(mapped, codec);
    const roots = history.conversationState.rootPromptMessagesJson.map((id) =>
      JSON.parse(required(history.blobs.get(id.toString('hex'))).toString('utf8')),
    );
    expect(roots).toEqual(
      source.messages.slice(0, 2).map((message) => ({ role: 'system', content: message.content })),
    );
  });

  it.each(['auto', 'none'] as const)(
    'advertises enabled meta and only slim names for %s',
    (choice) => {
      const mapped = mapCursorApiToolRequest({ ...request(), tool_choice: choice }).request;
      const result = codec.decode(
        'agent.v1.RequestContextResult',
        codec.encode('agent.v1.RequestContextResult', requestContextResult(mapped)),
      );
      const context = objectAt(result, ['result', 'value', 'requestContext']);
      const options = objectAt(context.mcpMetaToolOptions);
      expect(context.tools).toBeUndefined();
      expect(options.enabled).toBe(true);
      expect(options.mcpDescriptors ?? []).toEqual(
        choice === 'none'
          ? []
          : [
              {
                serverName: 'bridge',
                serverIdentifier: 'bridge',
                tools: [{ toolName: 'echo_value' }],
              },
            ],
      );
    },
  );

  it('keeps raw names in the full schema definition, including a raw bridge prefix', () => {
    const mapped = mapCursorApiToolRequest(request('bridge-echo_value')).request;
    const definition = nativeToolDefinition(required(mapped.tools?.[0]));
    expect(definition).toMatchObject({
      name: 'bridge-bridge-echo_value',
      toolName: 'bridge-echo_value',
      providerIdentifier: 'bridge',
    });
    expect(protoValueToJson(objectAt(definition.inputSchema))).toEqual(schema);
  });

  it.each([
    {},
    { serverIdentifiers: [] },
    { serverIdentifiers: ['bridge'] },
    { serverIdentifiers: ['missing'] },
    { serverIdentifiers: ['bridge', 'missing'], kickOnly: true },
  ])('serves full MCP state for %j', (value) => {
    const writes: Record<string, unknown>[] = [];
    handleExecResponse(
      {
        codec,
        request: mapCursorApiToolRequest(request()).request,
        writeMessage: (message) => {
          writes.push(roundTrip(message));
        },
        finish: (error) => {
          throw error;
        },
        completeTool: () => false,
      },
      { id: 17, execId: 'not-echoed', message: { case: 'mcpStateExecArgs', value } },
    );
    const exec = objectAt(roundTrip(required(writes[0])), ['message', 'value']);
    expect(exec.id).toBe(17);
    expect(exec.execId).toBeUndefined();
    expect(exec.localExecutionTimeMs).toEqual(expect.any(Number));
    expect(exec.localExecutionTimeMs).toBeGreaterThanOrEqual(0);
    const servers = arrayAt(exec, ['message', 'value', 'result', 'value', 'servers']);
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({
      serverName: 'bridge',
      serverIdentifier: 'bridge',
      status: 'connected',
    });
    const tool = objectAt(servers, [0, 'tools', 0]);
    expect(tool).toMatchObject({
      name: 'bridge-echo_value',
      toolName: 'echo_value',
      providerIdentifier: 'bridge',
      description: 'Echo a value',
    });
    expect(protoValueToJson(objectAt(tool.inputSchema))).toEqual(schema);
    expect(roundTrip(required(writes[1])).message).toEqual({
      case: 'execClientControlMessage',
      value: { message: { case: 'streamClose', value: { id: 17 } } },
    });
  });

  it('prefers canonical McpArgs name through interaction, exec, restoration, and result', () => {
    const mapping = mapCursorApiToolRequest(request());
    const events: CompletionStreamEvent[] = [];
    const held: HeldToolExec[] = [];
    const writes: Record<string, unknown>[] = [];
    const finish = vi.fn();
    const messages = new CursorRunMessages({
      codec,
      request: mapping.request,
      blobs: new Map(),
      heldExecs: held,
      emit: (event) => {
        events.push(event);
        return true;
      },
      finish,
      writeMessage: (message) => {
        writes.push(roundTrip(message));
      },
    });
    const args = nativeArgs();
    const send = (message: Record<string, unknown>) =>
      messages.handle(codec.encode('agent.v1.AgentServerMessage', { message }));
    send({
      case: 'interactionUpdate',
      value: {
        message: {
          case: 'toolCallStarted',
          value: {
            callId: 'native-call',
            toolCall: { toolCallId: 'native-call', tool: { case: 'mcpToolCall', value: { args } } },
          },
        },
      },
    });
    send({
      case: 'execServerMessage',
      value: { id: 23, execId: 'not-echoed', message: { case: 'mcpArgs', value: args } },
    });
    for (const updateCase of ['partialToolCall', 'toolCallCompleted']) {
      send({
        case: 'interactionUpdate',
        value: {
          message: {
            case: updateCase,
            value: {
              callId: 'native-call',
              toolCall: {
                toolCallId: 'native-call',
                tool: { case: 'mcpToolCall', value: { args } },
              },
              ...(updateCase === 'partialToolCall'
                ? { argsTextDelta: JSON.stringify({ value: null, nested: [true, false] }) }
                : {}),
            },
          },
        },
      });
    }
    expect(finish).not.toHaveBeenCalled();
    expect(held).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'tool_call_start', name: 'bridge-echo_value' });
    expect(events.filter((event) => event.type === 'tool_call_start')).toHaveLength(1);
    expect(mcpArgsToToolCall(args).function.name).toBe('bridge-echo_value');
    const calls = mapping.restoreToolCalls(messages.toolStream.completedCalls());
    expect(calls).toEqual([
      {
        id: 'native-call',
        type: 'function',
        function: {
          name: 'echo_value',
          arguments: JSON.stringify({ value: null, nested: [true, false] }),
        },
      },
    ]);
    sendHeldToolResult(
      (message) => {
        writes.push(roundTrip(message));
      },
      required(held[0]),
      'client-result',
    );
    const exec = objectAt(roundTrip(required(writes[0])), ['message', 'value']);
    expect(exec.id).toBe(23);
    expect(exec.execId).toBeUndefined();
    expect(exec.localExecutionTimeMs).toEqual(expect.any(Number));
    const result = objectAt(exec, ['message', 'value', 'result', 'value']);
    expect(result.isError).toBeUndefined();
    expect(valueAt(result, ['content', 0, 'content', 'value', 'text'])).toBe('client-result');
    expect(valueAt(roundTrip(required(writes[1])), ['message', 'value', 'message'])).toEqual({
      case: 'streamClose',
      value: { id: 23 },
    });
  });

  it('rejects an undeclared canonical name even when the raw toolName is declared', () => {
    const completeTool = vi.fn(() => true);
    const writes: Record<string, unknown>[] = [];
    handleExecResponse(
      {
        codec,
        request: mapCursorApiToolRequest(request()).request,
        completeTool,
        finish: (error) => {
          throw error;
        },
        writeMessage: (message) => {
          writes.push(message);
        },
      },
      {
        id: 9,
        message: {
          case: 'mcpArgs',
          value: { ...nativeArgs(), name: 'other-echo_value', toolName: 'bridge-echo_value' },
        },
      },
    );
    expect(completeTool).not.toHaveBeenCalled();
    expect(
      valueAt(roundTrip(required(writes[0])), [
        'message',
        'value',
        'message',
        'value',
        'result',
        'case',
      ]),
    ).toBe('error');
  });

  it.each([
    'mcpStateExecArgs',
    'requestContextArgs',
    'mcpAllowlistPrecheckArgs',
    'listMcpResourcesExecArgs',
  ])('measures local %s execution rather than using a fixed duration', (execCase) => {
    const now = vi.spyOn(performance, 'now').mockReturnValueOnce(100).mockReturnValue(118);
    const writes: Record<string, unknown>[] = [];
    try {
      handleExecResponse(
        {
          codec,
          request: mapCursorApiToolRequest(request()).request,
          completeTool: () => false,
          finish: (error) => {
            throw error;
          },
          writeMessage: (message) => {
            writes.push(message);
          },
        },
        { id: 5, execId: 'not-echoed', message: { case: execCase, value: {} } },
      );
      const exec = objectAt(roundTrip(required(writes[0])), ['message', 'value']);
      expect(exec.execId).toBeUndefined();
      expect(exec.localExecutionTimeMs).toBe(18);
      sendHeldToolResult(
        (message) => {
          writes.push(message);
        },
        { exec: { id: 6 }, startedAt: 103 },
        'result',
      );
      expect(
        valueAt(roundTrip(required(writes[2])), ['message', 'value', 'localExecutionTimeMs']),
      ).toBe(15);
    } finally {
      now.mockRestore();
    }
  });
});
