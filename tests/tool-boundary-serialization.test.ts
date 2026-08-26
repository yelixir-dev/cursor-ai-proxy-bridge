import { describe, expect, it } from 'vitest';
import { contentBoundaryDebug } from '../src/backend/content-boundary-debug.js';
import type {
  ChatCompletionRequest,
  CompletionStreamEvent,
  CursorBackend,
} from '../src/backend/types.js';
import type { BridgeConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';

const uuid = '550e8400-e29b-41d4-a716-446655440000';
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

function config(): BridgeConfig {
  return {
    host: '127.0.0.1',
    port: 9997,
    backend: 'mock',
    defaultModel: 'composer-2.5-fast',
    workspaceMode: 'chat-only',
    version: 'test',
    dashboardConfig: { modelOverrides: { 'composer-2.5-fast': true } },
  };
}

function boundaryBackend(): CursorBackend {
  const call = {
    id: uuid,
    type: 'function' as const,
    function: { name: 'read', arguments: '{"file_path":"/tmp/probe.txt"}' },
  };
  const events: CompletionStreamEvent[] = [
    { type: 'content', text: 'TOOL_OK' },
    { type: 'content', text: ' ' },
    { type: 'content', text: uuid },
    { type: 'tool_call_start', index: 0, id: call.id, name: call.function.name },
    {
      type: 'tool_call_arguments_delta',
      index: 0,
      id: call.id,
      delta: call.function.arguments,
    },
    { type: 'tool_call_complete', index: 0, call },
    {
      type: 'done',
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      is_error: false,
    },
  ];
  return {
    type: 'boundary',
    health: async () => ({ ok: true, type: 'boundary', authConfigured: true }),
    listModels: async () => [],
    complete: async (request: ChatCompletionRequest) => ({ content: '', model: request.model }),
    completeStream: async function* () {
      yield* events;
    },
  };
}

describe('content and tool boundary serialization', () => {
  it('records whitespace shape without logging generated content', () => {
    const metadata = contentBoundaryDebug({
      stage: 'cursor_upstream_delta',
      requested_model: 'composer-2.5-fast',
      reasoning_effort: 'default',
      request_id: 'run-1',
      chunk_index: 2,
      text: ' TOOL_OK ',
      cumulative_length: 9,
    });

    expect(metadata).toEqual({
      stage: 'cursor_upstream_delta',
      requested_model: 'composer-2.5-fast',
      reasoning_effort: 'default',
      request_id: 'run-1',
      chunk_index: 2,
      chunk_length: 9,
      cumulative_length: 9,
      starts_with_whitespace: true,
      ends_with_whitespace: true,
    });
    expect(JSON.stringify(metadata)).not.toContain('TOOL_OK');
  });

  it('preserves adjacent content bytes and unchanged tool identity', async () => {
    const server = await buildServer({ config: config(), backend: boundaryBackend() });
    try {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: {
          model: 'composer-2.5-fast',
          messages: [{ role: 'user', content: 'Read /tmp/probe.txt exactly once.' }],
          tools: [readTool],
          tool_choice: 'auto',
          stream: true,
        },
      });
      const chunks = response.body
        .split('\n')
        .filter((line) => line.startsWith('data: {'))
        .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
      const choices = chunks.flatMap((chunk) =>
        Array.isArray(chunk.choices) ? chunk.choices : [],
      ) as {
        delta?: {
          content?: string;
          tool_calls?: {
            id?: string;
            function?: { name?: string; arguments?: string };
          }[];
        };
      }[];
      const toolDeltas = choices.flatMap((choice) => choice.delta?.tool_calls ?? []);

      expect(choices.map((choice) => choice.delta?.content ?? '').join('')).toBe(
        `TOOL_OK ${uuid}`,
      );
      expect(toolDeltas.find((call) => call.id)?.id).toBe(uuid);
      expect(toolDeltas.find((call) => call.function?.name)?.function?.name).toBe('read');
      expect(toolDeltas.map((call) => call.function?.arguments ?? '').join('')).toBe(
        '{"file_path":"/tmp/probe.txt"}',
      );
    } finally {
      await server.close();
    }
  });
});
