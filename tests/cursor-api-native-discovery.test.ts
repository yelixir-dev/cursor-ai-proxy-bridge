import { describe, expect, it } from 'vitest';
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

// Field numbers/types are from the installed CLI, independently of the bridge
// descriptor that omitted discovery in the captured failing Runs.
const descriptors = loadProtoDescriptors();
const fixtureCodec = new ProtoCodec({
  ...descriptors,
  messages: {
    ...descriptors.messages,
    'agent.v1.ToolCall': {
      fields: [
        ...(descriptors.messages['agent.v1.ToolCall']?.fields ?? []).filter(
          (field) => field.no !== 44,
        ),
        {
          no: 44,
          name: 'get_mcp_tools_tool_call',
          localName: 'getMcpToolsToolCall',
          kind: 'message',
          repeated: false,
          oneof: 'tool',
          message: 'fixture.Discovery',
        },
      ],
    },
    'fixture.Discovery': {
      fields: [
        {
          no: 1,
          name: 'args',
          localName: 'args',
          kind: 'message',
          repeated: false,
          message: 'fixture.DiscoveryArgs',
        },
      ],
    },
    'fixture.DiscoveryArgs': {
      fields: [
        {
          no: 1,
          name: 'server',
          localName: 'server',
          kind: 'scalar',
          repeated: false,
          scalar: 9,
        },
        {
          no: 2,
          name: 'tool_name',
          localName: 'toolName',
          kind: 'scalar',
          repeated: false,
          scalar: 9,
        },
      ],
    },
  },
});

function discovery(): Buffer {
  return Buffer.concat(
    ['partialToolCall', 'toolCallStarted', 'toolCallCompleted'].map((caseName) =>
      encodeConnectFrame(
        fixtureCodec.encode('agent.v1.AgentServerMessage', {
          message: {
            case: 'interactionUpdate',
            value: {
              message: {
                case: caseName,
                value: {
                  callId: 'discovery-1',
                  toolCall: {
                    toolCallId: 'discovery-1',
                    tool: {
                      case: 'getMcpToolsToolCall',
                      value: {
                        args: {
                          server: 'bridge',
                          toolName: 'echo_value',
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        }),
      ),
    ),
  );
}

describe('native MCP discovery contract', () => {
  it.each([
    { choice: 'required' as const },
    {
      choice: {
        type: 'function' as const,
        function: { name: 'echo_value' },
      },
    },
  ])('returns model arguments after discovery with $choice', async ({ choice }) => {
    // Given: the live discovery announcement precedes actual MCP execution.
    const request: ChatCompletionRequest = {
      ...parallelToolRequest(),
      tool_choice: choice,
    };
    const transport = new ScriptedTransport((stream) => {
      stream.emit('response', { ':status': 200 });
      stream.emit(
        'data',
        Buffer.concat([discovery(), callBatch(wireToolName(request), 'exec-1', 'observed')]),
      );
    });
    const cursor = backend(transport);
    try {
      // When: required/named completion traverses the native adapter.
      const result = await cursor.complete(request);
      // Then: discovery neither consumes a call nor triggers recovery.
      expect(result.tool_calls?.map((call) => call.function)).toEqual([
        {
          name: 'echo_value',
          arguments: '{"value":"observed"}',
        },
      ]);
      expect(transport.opened).toHaveLength(1);
    } finally {
      await cursor.shutdown();
    }
  });

  it.each(['absent', 'none'] as const)(
    'allows discovery without executable tools when $0',
    async (choice) => {
      // Given: discovery is possible even when no tool may be executed.
      const request: ChatCompletionRequest =
        choice === 'none'
          ? { ...parallelToolRequest(), tool_choice: 'none' }
          : {
              model: 'composer-2.5',
              messages: [{ role: 'user', content: 'answer directly' }],
            };
      const transport = new ScriptedTransport((stream) => {
        stream.emit('response', { ':status': 200 });
        stream.emit(
          'data',
          Buffer.concat([
            discovery(),
            update('textDelta', { text: 'answer' }),
            update('turnEnded', {}),
            trailer(),
          ]),
        );
      });
      const cursor = backend(transport);
      try {
        // When: the same native discovery traverses the streaming path.
        const events = await collect(cursor, request);
        // Then: only text and terminal events reach the client.
        expect(events.map((event) => event.type)).toEqual(['content', 'done']);
        expect(transport.opened).toHaveLength(1);
      } finally {
        await cursor.shutdown();
      }
    },
  );

  it.each([
    { parallel: true, indices: [0, 1] },
    { parallel: false, indices: [0] },
  ])(
    'preserves response indices after discovery with parallel $parallel',
    async ({ parallel, indices }) => {
      // Given: discovery precedes two genuine native calls.
      const request = {
        ...parallelToolRequest(),
        parallel_tool_calls: parallel,
      };
      const transport = new ScriptedTransport((stream) => {
        stream.emit('response', { ':status': 200 });
        stream.emit(
          'data',
          Buffer.concat([
            discovery(),
            callBatch(wireToolName(request), 'exec-1', 'first'),
            callBatch(wireToolName(request), 'exec-2', 'second'),
          ]),
        );
      });
      const cursor = backend(transport);
      try {
        // When: calls pass through the incremental adapter.
        const events = await collect(cursor, request);
        // Then: discovery consumes no slot; the request cap applies to execution.
        const starts = events.filter((event) => event.type === 'tool_call_start');
        const completed = events.filter((event) => event.type === 'tool_call_complete');
        expect(starts.map((event) => event.index)).toEqual(indices);
        expect(completed.map((event) => event.index)).toEqual(indices);
        expect(completed.map((event) => JSON.parse(event.call.function.arguments))).toEqual(
          parallel ? [{ value: 'first' }, { value: 'second' }] : [{ value: 'first' }],
        );
        expect(transport.opened).toHaveLength(1);
      } finally {
        await cursor.shutdown();
      }
    },
  );

  it('rejects undeclared execution after allowed native discovery', async () => {
    // Given: legitimate discovery is followed by an undeclared executable tool.
    const request = parallelToolRequest();
    const transport = new ScriptedTransport((stream) => {
      stream.emit('response', { ':status': 200 });
      stream.emit('data', Buffer.concat([discovery(), callBatch('undeclared', 'bad-exec', 'bad')]));
    });
    const cursor = backend(transport);
    try {
      // When/Then: discovery grants no execution permission and no recovery.
      await expect(cursor.complete(request)).rejects.toThrow(/not among the declared tools/);
      expect(transport.opened).toHaveLength(1);
    } finally {
      await cursor.shutdown();
    }
  });
});
