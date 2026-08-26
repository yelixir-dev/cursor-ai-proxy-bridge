import { describe, expect, it } from 'vitest';
import { encodeConnectFrame } from '../src/backend/cursor-api/connect-frame.js';
import { loadProtoDescriptors, ProtoCodec } from '../src/backend/cursor-api/protobuf.js';
import type { ChatCompletionRequest, ToolCall } from '../src/backend/types.js';
import type { BridgeConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { backend, ScriptedTransport, update } from './support/cursor-api-scripted.js';

const codec = new ProtoCodec(loadProtoDescriptors());
const config: BridgeConfig = {
  host: '127.0.0.1',
  port: 0,
  apiKey: 'test-key',
  clientAuth: 'on',
  backend: 'cursor-api',
  defaultModel: 'composer-2.5',
  workspaceMode: 'chat-only',
  version: 'test',
  dashboardConfig: {
    modelOverrides: {
      'sonnet-5': true,
      'composer-2.5-fast': true,
      'opus-5': true,
    },
  },
};

const configFor = (model: string): BridgeConfig => ({ ...config, defaultModel: model });

function readRequest(
  model: string,
  toolChoice: ChatCompletionRequest['tool_choice'],
  name = 'read',
): ChatCompletionRequest {
  return {
    model,
    messages: [
      {
        role: 'user',
        content: 'Use the read tool to read /etc/hostname. Do not answer without calling a tool.',
      },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name,
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
      },
    ],
    tool_choice: toolChoice,
  };
}

function builtinReadFrames(includeToolCallId = true): Buffer {
  const toolCallId = 'builtin-read-1';
  return Buffer.concat([
    update('toolCallStarted', {
      callId: toolCallId,
      toolCall: {
        tool: {
          case: 'readToolCall',
          value: { args: { path: '/etc/hostname' } },
        },
        toolCallId,
      },
    }),
    encodeConnectFrame(
      codec.encode('agent.v1.AgentServerMessage', {
        message: {
          case: 'execServerMessage',
          value: {
            id: 1,
            execId: toolCallId,
            message: {
              case: 'readArgs',
              value: {
                path: '/etc/hostname',
                ...(includeToolCallId ? { toolCallId } : {}),
              },
            },
          },
        },
      }),
    ),
  ]);
}

function leakingBuiltinTransport(
  finalText = 'Tool execution is delegated to the OpenAI client',
  includeToolCallId = true,
) {
  return new ScriptedTransport((stream) => {
    stream.emit('response', { ':status': 200 });
    stream.once('write', () => {
      queueMicrotask(() => {
        stream.emit(
          'data',
          Buffer.concat([
            update('textDelta', { text: finalText }),
            update('turnEnded', { inputTokens: 4, outputTokens: 3 }),
          ]),
        );
      });
    });
    stream.emit('data', builtinReadFrames(includeToolCallId));
  });
}

function responseCall(response: { json(): unknown }): ToolCall {
  const body = response.json() as {
    choices?: Array<{
      finish_reason?: string;
      message?: { content?: string | null; tool_calls?: ToolCall[] };
    }>;
  };
  const choice = body.choices?.[0];
  expect(choice?.message?.content ?? '').not.toMatch(/delegated|OpenAI client/iu);
  expect(choice?.finish_reason).toBe('tool_calls');
  const call = choice?.message?.tool_calls?.[0];
  if (!call) throw new Error('response has no promoted tool call');
  return call;
}

async function promotedRead(
  model: string,
  toolChoice: ChatCompletionRequest['tool_choice'],
): Promise<ToolCall> {
  const transport = leakingBuiltinTransport();
  const server = await buildServer({ config: configFor(model), backend: backend(transport) });
  try {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer test-key' },
      payload: readRequest(model, toolChoice),
    });
    expect(response.statusCode, response.body).toBe(200);
    const call = responseCall(response);
    expect(call.function.name).toBe('read');
    expect(JSON.parse(call.function.arguments)).toEqual({ path: '/etc/hostname' });
    return call;
  } finally {
    await server.close();
  }
}

describe('Cursor builtin exec promotion', () => {
  it('promotes Sonnet Read under tool_choice auto without leaking rejection text', async () => {
    await promotedRead('sonnet-5', 'auto');
  });

  it('preserves required tool choice through builtin promotion', async () => {
    await promotedRead('sonnet-5', 'required');
  });

  it.each(['composer-2.5-fast', 'composer-2.5-fast'])(
    'promotes repeated Composer fast builtin attempts (%#)',
    async (model) => {
      await promotedRead(model, 'auto');
    },
  );

  it('preserves Opus auto tool calls', async () => {
    await promotedRead('opus-5', 'auto');
  });

  it('returns an OpenAI error instead of leaked assistant text when no tools are declared', async () => {
    const server = await buildServer({
      config: configFor('sonnet-5'),
      backend: backend(leakingBuiltinTransport()),
    });
    try {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: 'Bearer test-key' },
        payload: {
          model: 'sonnet-5',
          messages: [{ role: 'user', content: 'Read /etc/hostname.' }],
        },
      });
      expect(response.statusCode, response.body).toBe(502);
      expect(response.body).not.toMatch(/delegated|OpenAI client/iu);
    } finally {
      await server.close();
    }
  });

  it('does not force-map an unmatched builtin or leak its rejection text', async () => {
    const server = await buildServer({
      config: configFor('sonnet-5'),
      backend: backend(leakingBuiltinTransport()),
    });
    try {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: 'Bearer test-key' },
        payload: readRequest('sonnet-5', 'auto', 'get_seed'),
      });
      expect(response.statusCode, response.body).toBe(502);
      expect(response.body).not.toMatch(/delegated|OpenAI client/iu);
      expect(response.body).not.toContain('"name":"get_seed"');
    } finally {
      await server.close();
    }
  });

  it('resumes a promoted builtin with the client result and returns final text', async () => {
    const request = readRequest('sonnet-5', 'auto');
    const transport = leakingBuiltinTransport('HOST_RESULT_ACCEPTED', false);
    const server = await buildServer({
      config: configFor('sonnet-5'),
      backend: backend(transport, [{ id: 'only', apiKey: 'only-token' }], {
        CURSOR_BRIDGE_CURSOR_TIMEOUT_MS: '100',
      }),
    });
    try {
      const first = await server.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: 'Bearer test-key' },
        payload: request,
      });
      const call = responseCall(first);

      const second = await server.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: 'Bearer test-key' },
        payload: {
          ...request,
          messages: [
            ...request.messages,
            { role: 'assistant', content: null, tool_calls: [call] },
            { role: 'tool', tool_call_id: call.id, content: 'local-hostname' },
          ],
        },
      });

      expect(second.statusCode).toBe(200);
      expect(second.json()).toMatchObject({
        choices: [{ finish_reason: 'stop', message: { content: 'HOST_RESULT_ACCEPTED' } }],
      });
      expect(second.body).not.toMatch(/delegated|OpenAI client/iu);
    } finally {
      await server.close();
    }
  });
});
