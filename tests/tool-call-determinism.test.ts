import { describe, expect, it } from 'vitest';
import type { CursorApiBackend } from '../src/backend/cursor-api/backend.js';
import { jsonToProtoValue } from '../src/backend/cursor-api/protobuf.js';
import { CursorBuiltinToolCallError } from '../src/backend/cursor-api/run-messages.js';
import { mapCursorApiToolRequest } from '../src/backend/cursor-api/tool-wire-names.js';
import { runValidatedCursorCompletion } from '../src/backend/cursor-api/validated-run.js';
import type { ChatCompletionRequest } from '../src/backend/types.js';
import type { BridgeConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { builtinArgsFrame, clientMessageCases } from './support/cursor-api-builtin-frames.js';
import {
  backend,
  mcpArgsFrame,
  ScriptedTransport,
  toolCall,
  update,
} from './support/cursor-api-scripted.js';

const readTool = {
  type: 'function' as const,
  function: {
    name: 'read',
    parameters: {
      type: 'object',
      properties: { file_path: { type: 'string' } },
      required: ['file_path'],
    },
  },
};
const listTool = {
  type: 'function' as const,
  function: {
    name: 'ls',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
};

function configFor(model: string): BridgeConfig {
  return {
    host: '127.0.0.1',
    port: 9997,
    backend: 'cursor-api',
    defaultModel: model,
    workspaceMode: 'chat-only',
    version: 'test',
    dashboardConfig: { modelOverrides: { [model]: true } },
  };
}

function credential() {
  return {
    id: 'only',
    apiKey: 'only-token',
    weight: 1,
    enabled: true,
    plan: 'ultra',
    capabilities: { fable: true },
  };
}

function readExecFrame(): Buffer {
  return builtinArgsFrame(
    'readArgs',
    {
      path: '/tmp/probe.txt',
      execId: 'read-exec-1',
      toolCallId: 'read-tool-1',
    },
    1,
    'read-exec-1',
  );
}

function readFrames(): Buffer[] {
  const toolCallId = 'read-tool-1';
  return [
    update('toolCallStarted', {
      callId: toolCallId,
      toolCall: {
        tool: {
          case: 'readToolCall',
          value: { args: { path: '/tmp/probe.txt' } },
        },
        toolCallId,
      },
    }),
    readExecFrame(),
  ];
}

function listFrames(): Buffer[] {
  const toolCallId = 'ls-tool-1';
  return [
    update('toolCallStarted', {
      callId: toolCallId,
      toolCall: {
        tool: {
          case: 'lsToolCall',
          value: { args: { path: '/tmp' } },
        },
        toolCallId,
      },
    }),
    builtinArgsFrame('lsArgs', { path: '/tmp', execId: 'ls-exec-1', toolCallId }, 2, 'ls-exec-1'),
  ];
}

function nativeMcpFrame(
  name: string,
  argumentName: 'file_path' | 'path',
  path: string,
  index: number,
): Buffer {
  const toolCallId = `native-${name}-${index}`;
  return mcpArgsFrame(
    {
      ...toolCall(name, toolCallId, path),
      args: { [argumentName]: jsonToProtoValue(path) },
    },
    index,
    `native-exec-${index}`,
  );
}

function transportFor(frames: Buffer[]): ScriptedTransport {
  return new ScriptedTransport((stream) => {
    stream.emit('response', { ':status': 200 });
    queueMicrotask(() => {
      stream.emit('data', Buffer.concat(frames));
    });
  });
}

function cursorBackend(transport: ScriptedTransport): CursorApiBackend {
  return backend(transport, [credential()], {
    CURSOR_BRIDGE_CURSOR_TIMEOUT_MS: '100',
    CURSOR_BRIDGE_CURSOR_HOLD_TIMEOUT_MS: '100',
  });
}

function request(model: string, toolChoice: 'auto' | 'required'): ChatCompletionRequest {
  return {
    model,
    messages: [{ role: 'user', content: 'Read /tmp/probe.txt exactly once.' }],
    tools: [readTool],
    tool_choice: toolChoice,
    ...(model === 'fable-5' ? { reasoning_effort: 'xhigh' } : {}),
  };
}

describe('promoted builtin model matrix', () => {
  it.each([
    ['composer-2.5-fast', 'auto'],
    ['composer-2.5-fast', 'required'],
    ['sonnet-5', 'auto'],
    ['sonnet-5', 'required'],
    ['fable-5', 'auto'],
    ['fable-5', 'required'],
    ['gpt-5.6-sol', 'auto'],
    ['gpt-5.6-sol', 'required'],
  ] as const)('%s with tool_choice=%s emits one read call', async (model, toolChoice) => {
    const transport = transportFor(readFrames());
    const server = await buildServer({
      config: configFor(model),
      backend: cursorBackend(transport),
    });
    try {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: request(model, toolChoice),
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().choices[0].message.tool_calls).toHaveLength(1);
      expect(response.json().choices[0].message.tool_calls[0].function.name).toBe('read');
    } finally {
      await server.close();
    }
  });
});

describe('strict promoted builtin policy', () => {
  it('preserves optional auto with a single-call limit', () => {
    const mapped = mapCursorApiToolRequest({
      ...request('composer-2.5-fast', 'auto'),
      max_tool_calls: 1,
    }).request;

    expect(mapped.tool_choice).toBe('auto');
    expect(mapped.max_tool_calls).toBe(1);
  });

  it('limits a multi-tool auto request to one external call', async () => {
    const transport = transportFor([...readFrames(), ...listFrames()]);
    const server = await buildServer({
      config: configFor('composer-2.5-fast'),
      backend: cursorBackend(transport),
    });
    try {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: {
          ...request('composer-2.5-fast', 'auto'),
          tools: [readTool, listTool],
          max_tool_calls: 1,
        },
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().choices[0].message.tool_calls).toHaveLength(1);
      expect(response.json().choices[0].message.tool_calls[0].function.name).toBe('read');
    } finally {
      await server.close();
    }
  });

  it('limits a streaming multi-tool request to one external call', async () => {
    const transport = transportFor([...readFrames(), ...listFrames()]);
    const server = await buildServer({
      config: configFor('composer-2.5-fast'),
      backend: cursorBackend(transport),
    });
    try {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: {
          ...request('composer-2.5-fast', 'auto'),
          tools: [readTool, listTool],
          max_tool_calls: 1,
          stream: true,
        },
      });
      const chunks = response.body
        .split('\n')
        .filter((line) => line.startsWith('data: {'))
        .map((line) => JSON.parse(line.slice(6)));
      const toolDeltas = chunks.flatMap(
        (chunk) =>
          chunk.choices?.flatMap((choice: { delta?: { tool_calls?: unknown[] } }) =>
            choice.delta?.tool_calls ? choice.delta.tool_calls : [],
          ) ?? [],
      );

      expect(response.statusCode, response.body).toBe(200);
      expect(toolDeltas.filter((call) => call.id)).toHaveLength(1);
      expect(toolDeltas.find((call) => call.function?.name)?.function.name).toBe('read');
    } finally {
      await server.close();
    }
  });

  it('applies the same single-call limit to native MCP calls', async () => {
    const payload = {
      ...request('composer-2.5-fast', 'auto'),
      tools: [readTool, listTool],
      max_tool_calls: 1,
    };
    const [wireRead, wireList] =
      mapCursorApiToolRequest(payload).request.tools?.map((tool) => tool.function.name) ?? [];
    if (!wireRead || !wireList) throw new Error('missing native wire tool names');
    const transport = transportFor([
      nativeMcpFrame(wireRead, 'file_path', '/tmp/probe.txt', 1),
      nativeMcpFrame(wireList, 'path', '/tmp', 2),
    ]);
    const server = await buildServer({
      config: configFor('composer-2.5-fast'),
      backend: cursorBackend(transport),
    });
    try {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload,
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().choices[0].message.tool_calls).toEqual([
        {
          id: expect.stringMatching(/^call_[a-f0-9]{32}_0$/),
          type: 'function',
          function: { name: 'read', arguments: '{"file_path":"/tmp/probe.txt"}' },
        },
      ]);
    } finally {
      await server.close();
    }
  });

  it('retains the single-call budget during builtin recovery', async () => {
    const seenLimits: (number | undefined)[] = [];
    let attempt = 0;

    const outcome = await runValidatedCursorCompletion({
      request: {
        ...request('composer-2.5-fast', 'required'),
        max_tool_calls: 1,
      },
      lifecycle: {},
      run: async (candidate) => {
        seenLimits.push(candidate.max_tool_calls);
        attempt += 1;
        if (attempt === 1) throw new CursorBuiltinToolCallError();
        const name = candidate.tools?.[0]?.function.name;
        if (!name) throw new Error('missing recovery wire tool name');
        return {
          text: '',
          toolCalls: [
            {
              id: 'recovery-call-1',
              type: 'function',
              function: { name, arguments: '{"file_path":"/tmp/probe.txt"}' },
            },
            {
              id: 'recovery-call-2',
              type: 'function',
              function: { name, arguments: '{"file_path":"/tmp/extra.txt"}' },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          usageSource: 'unknown',
        };
      },
    });

    expect(seenLimits).toEqual([1, 1]);
    expect(outcome.toolCalls).toHaveLength(1);
    expect(outcome.toolCalls[0]?.id).toBe('recovery-call-1');
  });

  it('does not hold a builtin excluded by named tool choice', async () => {
    const transport = transportFor(listFrames());
    const server = await buildServer({
      config: configFor('sonnet-5'),
      backend: cursorBackend(transport),
    });
    try {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: {
          ...request('sonnet-5', 'auto'),
          tools: [readTool, listTool],
          tool_choice: { type: 'function', function: { name: 'read' } },
        },
      });

      expect(response.statusCode).toBe(502);
      expect(
        clientMessageCases(transport.opened.flatMap((run) => run.stream.writes)),
      ).not.toContain('holdMcp');
    } finally {
      await server.close();
    }
  });

  it('rejects an exec-only builtin when tool choice is none', async () => {
    const transport = transportFor([readExecFrame()]);
    const server = await buildServer({
      config: configFor('composer-2.5-fast'),
      backend: cursorBackend(transport),
    });
    try {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: {
          ...request('composer-2.5-fast', 'auto'),
          tool_choice: 'none',
        },
      });

      expect(response.statusCode).toBe(502);
      expect(
        clientMessageCases(transport.opened.flatMap((run) => run.stream.writes)),
      ).not.toContain('holdMcp');
    } finally {
      await server.close();
    }
  });
});
