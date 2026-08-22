import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import type { ChatCompletionRequest } from '../src/backend/types.js';
import type { BridgeConfig } from '../src/config.js';
import {
  backend,
  callBatch,
  parallelToolRequest,
  ScriptedTransport,
  update,
  wireToolName,
} from './support/cursor-api-scripted.js';

const config: BridgeConfig = {
  host: '127.0.0.1',
  port: 0,
  apiKey: 'test-key',
  clientAuth: 'on',
  backend: 'cursor-api',
  defaultModel: 'composer-2.5',
  workspaceMode: 'chat-only',
  version: 'test',
};

function builtinShellCall(): Buffer {
  return update('toolCallStarted', {
    callId: 'builtin-1',
    toolCall: {
      tool: { case: 'shellToolCall', value: { args: { command: 'echo seed' } } },
      toolCallId: 'builtin-1',
    },
  });
}

describe('cursor-api required tool recovery over SSE', () => {
  it('retries a builtin before emitting indexed external tool deltas', async () => {
    // Given: the first required Run selects a Cursor builtin and the recovery
    // Run returns the declared external tool.
    const request: ChatCompletionRequest = {
      ...parallelToolRequest(),
      tool_choice: 'required',
      messages: [{ role: 'user', content: 'Call echo_value with streamed.' }],
    };
    const externalName = wireToolName(request);
    const transport = new ScriptedTransport((stream) => {
      stream.emit('response', { ':status': 200 });
      stream.emit(
        'data',
        transport.opened.length === 1
          ? builtinShellCall()
          : callBatch(externalName, 'external-2', 'streamed'),
      );
    });
    const server = await buildServer({ config, backend: backend(transport) });

    try {
      // When: the client uses the real streaming HTTP endpoint.
      const response = await server.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: 'Bearer test-key' },
        payload: { ...request, stream: true },
      });

      // Then: recovery is hidden and the SSE surface contains only the
      // declared OpenAI tool call followed by a normal terminator.
      expect(response.statusCode).toBe(200);
      expect(String(response.headers['content-type'])).toContain('text/event-stream');
      expect(response.body).not.toContain('[TOOL_CALLS:');
      expect(response.body.trim().endsWith('data: [DONE]')).toBe(true);
      expect(transport.opened).toHaveLength(2);

      const frames = response.body
        .split('\n\n')
        .filter((frame) => frame.startsWith('data: {'))
        .map(
          (frame) =>
            JSON.parse(frame.slice('data: '.length)) as {
              choices: Array<{
                delta: {
                  tool_calls?: Array<{
                    index: number;
                    function?: { name?: string; arguments?: string };
                  }>;
                };
              }>;
            },
        );
      const deltas = frames.flatMap((frame) => frame.choices[0]?.delta.tool_calls ?? []);
      expect(deltas.every((delta) => Number.isInteger(delta.index))).toBe(true);
      expect(deltas.find((delta) => delta.function?.name)?.function?.name).toBe('echo_value');
      const argumentsJson = deltas.map((delta) => delta.function?.arguments ?? '').join('');
      expect(JSON.parse(argumentsJson)).toEqual({ value: 'streamed' });
    } finally {
      await server.close();
    }
  });
});
