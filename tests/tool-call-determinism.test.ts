import { describe, expect, it } from 'vitest';
import type { CursorApiBackend } from '../src/backend/cursor-api/backend.js';
import { mapCursorApiToolRequest } from '../src/backend/cursor-api/tool-wire-names.js';
import type { ChatCompletionRequest } from '../src/backend/types.js';
import type { BridgeConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { builtinArgsFrame, clientMessageCases } from './support/cursor-api-builtin-frames.js';
import { backend, ScriptedTransport, update } from './support/cursor-api-scripted.js';

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
  it('strengthens single-tool auto to a named wire choice', () => {
    const mapped = mapCursorApiToolRequest({
      ...request('composer-2.5-fast', 'auto'),
      max_tool_calls: 1,
    }).request;

    expect(mapped.tool_choice).toEqual({
      type: 'function',
      function: { name: mapped.tools?.[0]?.function.name },
    });
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
