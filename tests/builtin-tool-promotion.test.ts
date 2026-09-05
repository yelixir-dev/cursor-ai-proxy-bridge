import { describe, expect, it } from 'vitest';
import {
  builtinStartRouting,
  builtinToolRoutingLog,
  promoteBuiltinExec,
} from '../src/backend/cursor-api/builtin-tool-promotion.js';
import { builtinToolResultReply } from '../src/backend/cursor-api/builtin-tool-results.js';
import { buildCursorHistory } from '../src/backend/cursor-api/history.js';
import { mcpArgsToToolCall } from '../src/backend/cursor-api/mcp-tool-call.js';
import { loadProtoDescriptors, ProtoCodec } from '../src/backend/cursor-api/protobuf.js';
import type { ChatCompletionRequest } from '../src/backend/types.js';

function request(name: string, properties: Record<string, unknown>): ChatCompletionRequest {
  return {
    model: 'sonnet-5',
    messages: [{ role: 'user', content: 'use a tool' }],
    tools: [
      {
        type: 'function',
        function: {
          name,
          parameters: { type: 'object', properties },
        },
      },
    ],
    tool_choice: 'auto',
  };
}

describe('builtin tool promotion mapping', () => {
  it('matches Read case-insensitively and maps path to file_path', () => {
    const promoted = promoteBuiltinExec(
      request('READ', { file_path: { type: 'string' } }),
      { execId: 'read-exec' },
      'readArgs',
      { path: '/etc/hostname', toolCallId: 'read-call' },
    );

    expect(promoted?.debug).toMatchObject({
      execCase: 'readArgs',
      attemptedToolName: 'read',
      declaredToolNames: ['READ'],
      mappedOpenAiToolName: 'READ',
      requested_model: 'sonnet-5',
      reasoning_effort: 'default',
      tool_choice: 'auto',
    });
    expect(mcpArgsToToolCall(promoted?.tool ?? {})).toMatchObject({
      id: 'read-call',
      function: {
        name: 'READ',
        arguments: JSON.stringify({ file_path: '/etc/hostname' }),
      },
    });
  });

  it('emits safe deterministic promoted builtin diagnostic metadata', () => {
    const toolRequest = {
      ...request('read', { path: { type: 'string' } }),
      apiKey: 'secret-api-key',
      messages: [{ role: 'user' as const, content: 'secret-prompt-content' }],
      reasoning_effort: 'xhigh',
    };
    const promoted = promoteBuiltinExec(toolRequest, { execId: 'read-exec' }, 'readArgs', {
      path: '/etc/hostname',
      toolCallId: 'read-call',
      credential: 'secret-credential',
      generatedContent: 'secret-generated-content',
    });
    if (!promoted) throw new Error('expected builtin promotion');

    const log = builtinToolRoutingLog(promoted.debug, {
      runRequestId: 'run-request-1',
      toolCallIndex: 0,
      disposition: 'promoted',
    });

    expect(log).toEqual({
      requested_model: 'sonnet-5',
      reasoning_effort: 'xhigh',
      tool_choice: 'auto',
      declared_tool_names: ['read'],
      attempted_builtin_name: 'read',
      promoted_external_tool_name: 'read',
      tool_call_index: 0,
      run_request_id: 'run-request-1',
      call_origin: 'model_generated_builtin',
      disposition: 'promoted',
    });
    const serialized = JSON.stringify(log);
    expect(serialized).not.toMatch(
      /secret-api-key|secret-credential|secret-prompt-content|secret-generated-content/u,
    );
    expect(serialized).not.toContain('/etc/hostname');
  });

  it('maps Cursor Shell only to a declared shell or bash function', () => {
    const promoted = promoteBuiltinExec(
      request('bash', { command: { type: 'string' } }),
      { execId: 'shell-exec' },
      'shellArgs',
      { command: 'pwd', toolCallId: 'shell-call' },
    );

    expect(mcpArgsToToolCall(promoted?.tool ?? {})).toMatchObject({
      id: 'shell-call',
      function: { name: 'bash', arguments: JSON.stringify({ command: 'pwd' }) },
    });
  });

  it('does not map an unrelated declaration at start or exec completion', () => {
    const toolRequest = request('get_seed', { seed: { type: 'string' } });
    const start = builtinStartRouting(toolRequest, {
      toolCall: { tool: { case: 'readToolCall', value: {} } },
    });
    const completed = promoteBuiltinExec(toolRequest, { execId: 'read-exec' }, 'readArgs', {
      path: '/etc/hostname',
    });

    expect(start?.mappedOpenAiToolName).toBeUndefined();
    expect(completed?.debug.mappedOpenAiToolName).toBeUndefined();
    expect(completed?.tool).toEqual({});
  });

  it('does not inject tool guidance roots for auto requests', () => {
    const history = buildCursorHistory(request('read', { path: { type: 'string' } }), {
      encode: () => Buffer.alloc(0),
    });
    expect(history.conversationState.rootPromptMessagesJson).toEqual([]);
  });

  it('encodes the client result as the original builtin success response', () => {
    const reply = builtinToolResultReply(
      { execCase: 'readArgs', args: { path: '/etc/hostname' } },
      'test-hostname',
    );
    const codec = new ProtoCodec(loadProtoDescriptors());
    const encoded = codec.encode('agent.v1.AgentClientMessage', {
      message: {
        case: 'execClientMessage',
        value: {
          id: 1,
          execId: 'read-exec',
          message: { case: reply?.messageCase, value: reply?.value },
        },
      },
    });
    const decoded = codec.decode('agent.v1.AgentClientMessage', encoded);

    expect(decoded).toMatchObject({
      message: {
        case: 'execClientMessage',
        value: {
          execId: 'read-exec',
          message: {
            case: 'readResult',
            value: {
              result: {
                case: 'success',
                value: {
                  path: '/etc/hostname',
                  output: { case: 'content', value: 'test-hostname' },
                },
              },
            },
          },
        },
      },
    });
  });
});
