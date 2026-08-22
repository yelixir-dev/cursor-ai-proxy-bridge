import { describe, expect, it } from 'vitest';
import { ConnectFrameDecoder } from '../src/backend/cursor-api/connect-frame.js';
import { encodeConnectFrame } from '../src/backend/cursor-api/connect-frame.js';
import { loadProtoDescriptors, ProtoCodec } from '../src/backend/cursor-api/protobuf.js';
import type { ChatCompletionRequest } from '../src/backend/types.js';
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

const codec = new ProtoCodec(loadProtoDescriptors());

function execFrame(caseName: string, value: Record<string, unknown>): Buffer {
  return encodeConnectFrame(
    codec.encode('agent.v1.AgentServerMessage', {
      message: {
        case: 'execServerMessage',
        value: { id: 1, execId: 'exec-1', message: { case: caseName, value } },
      },
    }),
  );
}

function toolCallStarted(name: string): Buffer {
  return update('toolCallStarted', {
    callId: 'c1',
    toolCall: {
      tool: {
        case: 'mcpToolCall',
        value: {
          args: { name, toolName: name, providerIdentifier: 'bridge', toolCallId: 'c1', args: {} },
        },
      },
      toolCallId: 'c1',
    },
  });
}

function decodeExecClients(writes: readonly Buffer[]): Array<Record<string, unknown>> {
  const decoder = new ConnectFrameDecoder();
  const messages: Array<Record<string, unknown>> = [];
  for (const write of writes) {
    for (const frame of decoder.push(write)) {
      if (!frame.payload) continue;
      const decoded = codec.decode('agent.v1.AgentClientMessage', frame.payload) as {
        message?: { case?: string; value?: unknown };
      };
      if (decoded.message?.case === 'execClientMessage') {
        messages.push(decoded.message.value as Record<string, unknown>);
      }
    }
  }
  return messages;
}

describe('cursor-api undeclared tool-call guard', () => {
  it('fails fast when the model attempts a tool call with no tools declared', async () => {
    // Given: the prompt asks for a tool but the request declares none, and
    // upstream emits a toolCallStarted interaction with no exec frame after
    // it (the live stall signature: tool_decision, then silence).
    const request: ChatCompletionRequest = {
      model: 'composer-2.5',
      messages: [{ role: 'user', content: 'Call get_seed.' }],
    };
    const transport = new ScriptedTransport((stream) => {
      stream.emit('response', { ':status': 200 });
      stream.emit('data', toolCallStarted('get_seed'));
    });

    // When/Then: the completion rejects immediately instead of timing out.
    await expect(collect(backend(transport), request)).rejects.toThrow(/no usable tools/);
  });

  it('fails fast when the model attempts a tool that was not declared', async () => {
    // Given: echo_value is declared but the prompt leads the model to
    // get_seed, so the interaction names a tool outside the declared set.
    const request = parallelToolRequest();
    const transport = new ScriptedTransport((stream) => {
      stream.emit('response', { ':status': 200 });
      stream.emit('data', toolCallStarted('get_seed'));
    });

    await expect(collect(backend(transport), request)).rejects.toThrow(/get_seed/);
  });

  it('retries a builtin misselection as the single required external tool', async () => {
    // Given: one external tool is declared and required, but the first Run
    // selects Cursor's builtin shell tool instead.
    const request: ChatCompletionRequest = {
      ...parallelToolRequest(),
      tool_choice: 'required',
      messages: [{ role: 'user', content: 'Call get_seed.' }],
    };
    const externalName = wireToolName(request);
    const transport = new ScriptedTransport((stream) => {
      stream.emit('response', { ':status': 200 });
      stream.emit(
        'data',
        transport.opened.length === 1 ? builtinShellCall() : callBatch(externalName, 'c2', 'seed'),
      );
    });

    // When: the bridge handles the pre-visible builtin misselection.
    const result = await backend(transport).complete(request);

    // Then: it makes one exact-tool recovery Run and returns the declared
    // OpenAI tool name rather than a 502.
    expect(transport.opened).toHaveLength(2);
    expect(result.tool_calls).toEqual([
      {
        id: 'c2',
        type: 'function',
        function: { name: 'echo_value', arguments: '{"value":"seed"}' },
      },
    ]);
  });

  it('bounds repeated builtin misselection with an actionable error', async () => {
    // Given: Composer selects a builtin on both the original and exact-tool
    // recovery Runs.
    const request: ChatCompletionRequest = {
      ...parallelToolRequest(),
      tool_choice: 'required',
    };
    const transport = new ScriptedTransport((stream) => {
      stream.emit('response', { ':status': 200 });
      stream.emit('data', builtinShellCall());
    });

    // When/Then: recovery is bounded and tells the client how to relax the
    // request if the external tool is optional.
    await expect(collect(backend(transport), request)).rejects.toThrow(
      /retry with tool_choice="auto"/,
    );
    expect(transport.opened).toHaveLength(2);
  });

  it('retries a builtin misselection when multiple external tools are required', async () => {
    // Given: multiple external tools are declared, but the first required
    // Run selects a Cursor builtin instead of any external tool.
    const base = parallelToolRequest();
    const request: ChatCompletionRequest = {
      ...base,
      tools: [
        ...(base.tools ?? []),
        {
          type: 'function',
          function: {
            name: 'lookup_code',
            parameters: {
              type: 'object',
              properties: { key: { type: 'string' } },
              required: ['key'],
            },
          },
        },
      ],
      tool_choice: 'required',
    };
    const externalName = wireToolName(request);
    const transport = new ScriptedTransport((stream) => {
      stream.emit('response', { ':status': 200 });
      stream.emit(
        'data',
        transport.opened.length === 1
          ? builtinShellCall()
          : callBatch(externalName, 'c2', 'recovered'),
      );
    });

    // When: the bridge handles the pre-visible builtin misselection.
    const result = await backend(transport).complete(request);

    // Then: one bounded retry returns a declared external call instead of 502.
    expect(transport.opened).toHaveLength(2);
    expect(result.tool_calls).toEqual([
      {
        id: 'c2',
        type: 'function',
        function: { name: 'echo_value', arguments: '{"value":"recovered"}' },
      },
    ]);
  });

  it('advertises no tools upstream when tool_choice is none', async () => {
    // Given: tools present but tool_choice none — nothing may be advertised.
    const request: ChatCompletionRequest = {
      ...parallelToolRequest(),
      tool_choice: 'none',
    };
    const transport = new ScriptedTransport((stream) => {
      stream.emit('response', { ':status': 200 });
      stream.emit(
        'data',
        Buffer.concat([
          execFrame('requestContextArgs', {}),
          execFrame('mcpStateExecArgs', {}),
          update('textDelta', { text: 'plain answer' }),
          update('turnEnded', { inputTokens: 1, outputTokens: 1 }),
          trailer(),
        ]),
      );
    });

    const events = await collect(backend(transport), request);
    expect(events.at(-1)?.type).toBe('done');

    const execs = decodeExecClients(transport.opened[0]?.stream.writes ?? []);
    const contextResult = execs.find(
      (exec) =>
        (exec.message as Record<string, unknown> | undefined)?.case === 'requestContextResult',
    );
    const contextValue = (contextResult?.message as Record<string, unknown> | undefined)
      ?.value as Record<string, unknown>;
    const success = contextValue.result as Record<string, unknown>;
    const successValue = success.value as Record<string, unknown>;
    const requestContext = successValue.requestContext as Record<string, unknown>;
    // The codec omits empty repeated fields; either form means no tools were advertised.
    expect(requestContext.tools ?? []).toEqual([]);

    const stateResult = execs.find(
      (exec) =>
        (exec.message as Record<string, unknown> | undefined)?.case === 'mcpStateExecResult',
    );
    const stateValue = (stateResult?.message as Record<string, unknown> | undefined)
      ?.value as Record<string, unknown>;
    const stateSuccess = (stateValue.result as Record<string, unknown>).value as Record<
      string,
      unknown
    >;
    expect(stateSuccess.servers ?? []).toEqual([]);
  });
});

function builtinShellCall(): Buffer {
  return update('toolCallStarted', {
    callId: 'c1',
    toolCall: {
      tool: { case: 'shellToolCall', value: { args: { command: 'echo seed' } } },
      toolCallId: 'c1',
    },
  });
}
