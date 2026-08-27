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
const boundaryCall = {
  id: uuid,
  type: 'function' as const,
  function: { name: 'read', arguments: '{"file_path":"/tmp/probe.txt"}' },
};

type StreamChoice = {
  readonly delta?: {
    readonly content?: string;
    readonly tool_calls?: {
      readonly id?: string;
      readonly function?: { readonly name?: string; readonly arguments?: string };
    }[];
  };
};

function streamChoices(body: string): StreamChoice[] {
  const chunks = body
    .split('\n')
    .filter((line) => line.startsWith('data: {'))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
  return chunks.flatMap((chunk) => (Array.isArray(chunk.choices) ? chunk.choices : []));
}

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
  const events: CompletionStreamEvent[] = [
    { type: 'content', text: 'TOOL_OK' },
    { type: 'content', text: ' ' },
    { type: 'content', text: uuid },
    {
      type: 'tool_call_start',
      index: 0,
      id: boundaryCall.id,
      name: boundaryCall.function.name,
    },
    {
      type: 'tool_call_arguments_delta',
      index: 0,
      id: boundaryCall.id,
      delta: boundaryCall.function.arguments,
    },
    { type: 'tool_call_complete', index: 0, call: boundaryCall },
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
    complete: async (request: ChatCompletionRequest) => ({
      content: `TOOL_OK ${uuid}`,
      model: request.model,
      tool_calls: [boundaryCall],
    }),
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
      const choices = streamChoices(response.body);
      const toolDeltas = choices.flatMap((choice) => choice.delta?.tool_calls ?? []);
      const lastContentIndex = choices.findLastIndex(
        (choice) => choice.delta?.content !== undefined,
      );
      const firstToolIndex = choices.findIndex((choice) => choice.delta?.tool_calls !== undefined);

      expect(choices.map((choice) => choice.delta?.content ?? '').join('')).toBe(`TOOL_OK ${uuid}`);
      expect(firstToolIndex).toBeGreaterThan(lastContentIndex);
      expect(toolDeltas.find((call) => call.id)?.id).toBe(uuid);
      expect(toolDeltas.find((call) => call.function?.name)?.function?.name).toBe('read');
      expect(toolDeltas.map((call) => call.function?.arguments ?? '').join('')).toBe(
        '{"file_path":"/tmp/probe.txt"}',
      );
    } finally {
      await server.close();
    }
  });

  it('emits equivalent streaming and non-streaming tool structures', async () => {
    const server = await buildServer({ config: config(), backend: boundaryBackend() });
    try {
      const payload = {
        model: 'composer-2.5-fast',
        messages: [{ role: 'user', content: 'Read /tmp/probe.txt exactly once.' }],
        tools: [readTool],
        tool_choice: 'auto',
      };
      const nonStreaming = await server.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload,
      });
      const streaming = await server.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: { ...payload, stream: true },
      });

      const nonStreamingMessage = nonStreaming.json().choices[0].message;
      const choices = streamChoices(streaming.body);
      const toolDeltas = choices.flatMap((choice) => choice.delta?.tool_calls ?? []);
      const streamingCall = {
        id: toolDeltas.find((call) => call.id)?.id,
        type: 'function',
        function: {
          name: toolDeltas.find((call) => call.function?.name)?.function?.name,
          arguments: toolDeltas.map((call) => call.function?.arguments ?? '').join(''),
        },
      };

      expect(nonStreaming.statusCode).toBe(200);
      expect(streaming.statusCode).toBe(200);
      expect(streamingCall).toEqual(nonStreamingMessage.tool_calls[0]);
    } finally {
      await server.close();
    }
  });
});
