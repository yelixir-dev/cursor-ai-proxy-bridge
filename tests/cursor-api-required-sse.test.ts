import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import type { ChatCompletionRequest, ToolCall } from '../src/backend/types.js';
import type { BridgeConfig } from '../src/config.js';
import {
  backend,
  callBatch,
  parallelToolRequest,
  ScriptedTransport,
  trailer,
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

function jsonToolCall(response: { json(): unknown }): ToolCall {
  const body = response.json() as {
    choices?: Array<{ message?: { tool_calls?: ToolCall[] }; finish_reason?: string }>;
  };
  const choice = body.choices?.[0];
  const call = choice?.message?.tool_calls?.[0];
  if (!call) throw new Error('JSON response has no tool call');
  expect(choice?.finish_reason).toBe('tool_calls');
  expect(choice.message?.tool_calls).toHaveLength(1);
  return call;
}

function sseToolCall(body: string): ToolCall {
  const calls = new Map<number, ToolCall>();
  for (const frame of body.split('\n\n')) {
    if (!frame.startsWith('data: {')) continue;
    const parsed = JSON.parse(frame.slice('data: '.length)) as {
      choices?: Array<{
        delta?: {
          tool_calls?: Array<{
            index: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
        finish_reason?: string | null;
      }>;
    };
    for (const delta of parsed.choices?.[0]?.delta?.tool_calls ?? []) {
      const current = calls.get(delta.index);
      calls.set(delta.index, {
        id: delta.id ?? current?.id ?? '',
        type: 'function',
        function: {
          name: delta.function?.name ?? current?.function.name ?? '',
          arguments: `${current?.function.arguments ?? ''}${delta.function?.arguments ?? ''}`,
        },
      });
    }
  }
  expect(body).toContain('"finish_reason":"tool_calls"');
  expect(body.trim().endsWith('data: [DONE]')).toBe(true);
  expect(calls.size).toBe(1);
  const call = calls.get(0);
  if (!call) throw new Error('SSE response has no indexed tool call');
  return call;
}

describe('cursor-api required tool recovery over SSE', () => {
  it('resets a resumed late sibling to SSE tool index zero', async () => {
    // Given: call A parks one Run, while serial sibling B is announced only
    // after A's result resumes that same Run.
    const request: ChatCompletionRequest = {
      ...parallelToolRequest(),
      tool_choice: 'auto',
    };
    const wireName = wireToolName(request);
    const transport = new ScriptedTransport((stream) => {
      stream.emit('response', { ':status': 200 });
      stream.emit('data', callBatch(wireName, 'call-a', 'A'));
    });
    const server = await buildServer({ config, backend: backend(transport) });

    try {
      const first = await server.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: 'Bearer test-key' },
        payload: { ...request, stream: true },
      });
      expect(first.statusCode).toBe(200);
      const callA = sseToolCall(first.body);
      const run = await transport.firstRun;
      const resultWritten = Promise.withResolvers<void>();
      run.stream.once('write', () => resultWritten.resolve());

      // When: response 2 resumes A and B streams from native slot 1.
      const secondPromise = server.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: 'Bearer test-key' },
        payload: {
          ...request,
          stream: true,
          messages: [
            ...request.messages,
            { role: 'assistant', content: null, tool_calls: [callA] },
            { role: 'tool', tool_call_id: callA.id, content: 'result-A' },
          ],
        },
      });
      await resultWritten.promise;
      run.stream.emit('data', callBatch(wireName, 'call-b', 'B'));
      const second = await secondPromise;

      // Then: every B fragment and completion belongs to response-local slot 0.
      expect(second.statusCode).toBe(200);
      const callB = sseToolCall(second.body);
      expect(JSON.parse(callB.function.arguments)).toEqual({ value: 'B' });
      expect(second.body).not.toContain('"index":1');
      expect(transport.opened).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it.each([
    { label: 'JSON', stream: false },
    { label: 'SSE', stream: true },
  ])('rejects assistant-empty terminal Runs over $label', async ({ stream }) => {
    for (const terminal of [
      { frames: trailer(), sseStarted: false },
      {
        frames: Buffer.concat([
          update('thinkingDelta', { text: 'hidden reasoning only' }),
          update('turnEnded', { inputTokens: 2, outputTokens: 1 }),
          trailer(),
        ]),
        sseStarted: true,
      },
    ]) {
      const transport = new ScriptedTransport((active) => {
        active.emit('response', { ':status': 200 });
        active.emit('data', terminal.frames);
      });
      const server = await buildServer({ config, backend: backend(transport) });

      try {
        const response = await server.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: { authorization: 'Bearer test-key' },
          payload: {
            model: 'composer-2.5',
            messages: [{ role: 'user', content: 'return visible output' }],
            stream,
          },
        });
        expect(response.statusCode).toBe(stream && terminal.sseStarted ? 200 : 502);
        expect(response.body).toContain('ended without content or tool calls');
        expect(response.body).not.toContain('"finish_reason":"stop"');
        expect(response.body).not.toContain('data: [DONE]');
      } finally {
        await server.close();
      }
    }
  });

  it('serializes three same-Run siblings over required JSON responses', async () => {
    // Given: one native Run pre-announces three external calls while the
    // OpenAI client requires tools but disallows parallel responses.
    const request: ChatCompletionRequest = {
      ...parallelToolRequest(),
      tool_choice: 'required',
      parallel_tool_calls: false,
      messages: [{ role: 'user', content: 'Call echo_value with A, then B, then C.' }],
    };
    const wireName = wireToolName(request);
    const transport = new ScriptedTransport((stream) => {
      stream.emit('response', { ':status': 200 });
      if (transport.opened.length > 1) {
        stream.emit(
          'data',
          Buffer.concat([
            update('textDelta', { text: 'JSON_SERIAL_DONE' }),
            update('turnEnded', { inputTokens: 6, outputTokens: 2 }),
            trailer(),
          ]),
        );
        return;
      }
      stream.emit(
        'data',
        Buffer.concat([
          callBatch(wireName, 'call-a', 'A'),
          callBatch(wireName, 'call-b', 'B'),
          callBatch(wireName, 'call-c', 'C'),
        ]),
      );
    });
    const server = await buildServer({ config, backend: backend(transport) });

    try {
      const messages: unknown[] = request.messages.map((message) => message);
      for (const expected of ['A', 'B', 'C']) {
        const response = await server.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: { authorization: 'Bearer test-key' },
          payload: { ...request, messages },
        });
        expect(response.statusCode).toBe(200);
        const call = jsonToolCall(response);
        expect(JSON.parse(call.function.arguments)).toEqual({ value: expected });
        messages.push(
          { role: 'assistant', content: null, tool_calls: [call] },
          { role: 'tool', tool_call_id: call.id, content: `result-${expected}` },
        );
      }

      // Then: all three OpenAI responses came from one native Run; the final
      // auto policy starts a fresh Run with C in replayed history.
      const run = await transport.firstRun;
      expect(transport.opened).toHaveLength(1);
      const originalWrites = run.stream.writes.length;
      const finalPromise = server.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: 'Bearer test-key' },
        payload: { ...request, tool_choice: 'auto', messages },
      });
      const final = await finalPromise;
      expect(final.statusCode).toBe(200);
      expect(final.json()).toMatchObject({
        choices: [{ message: { content: 'JSON_SERIAL_DONE' }, finish_reason: 'stop' }],
      });
      expect(run.stream.writes).toHaveLength(originalWrites);
      expect(transport.opened).toHaveLength(2);
    } finally {
      await server.close();
    }
  });

  it('serializes three named-function siblings over SSE responses', async () => {
    // Given: named-function choice takes the buffered required path while the
    // native Run has three serial siblings ready.
    const request: ChatCompletionRequest = {
      ...parallelToolRequest(),
      tool_choice: { type: 'function', function: { name: 'echo_value' } },
      parallel_tool_calls: false,
      messages: [{ role: 'user', content: 'Call echo_value with A, then B, then C.' }],
    };
    const wireName = wireToolName(request);
    const transport = new ScriptedTransport((stream) => {
      stream.emit('response', { ':status': 200 });
      if (transport.opened.length > 1) {
        stream.emit(
          'data',
          Buffer.concat([
            update('textDelta', { text: 'SSE_SERIAL_DONE' }),
            update('turnEnded', { inputTokens: 6, outputTokens: 2 }),
            trailer(),
          ]),
        );
        return;
      }
      stream.emit(
        'data',
        Buffer.concat([
          callBatch(wireName, 'call-a', 'A'),
          callBatch(wireName, 'call-b', 'B'),
          callBatch(wireName, 'call-c', 'C'),
        ]),
      );
    });
    const server = await buildServer({ config, backend: backend(transport) });

    try {
      const messages: unknown[] = request.messages.map((message) => message);
      for (const expected of ['A', 'B', 'C']) {
        const response = await server.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: { authorization: 'Bearer test-key' },
          payload: { ...request, stream: true, messages },
        });
        expect(response.statusCode).toBe(200);
        const call = sseToolCall(response.body);
        expect(JSON.parse(call.function.arguments)).toEqual({ value: expected });
        messages.push(
          { role: 'assistant', content: null, tool_calls: [call] },
          { role: 'tool', tool_call_id: call.id, content: `result-${expected}` },
        );
      }

      const run = await transport.firstRun;
      expect(transport.opened).toHaveLength(1);
      const originalWrites = run.stream.writes.length;
      const finalPromise = server.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: 'Bearer test-key' },
        payload: { ...request, stream: true, tool_choice: 'auto', messages },
      });
      const final = await finalPromise;
      expect(final.statusCode).toBe(200);
      expect(final.body).toContain('SSE_SERIAL_DONE');
      expect(final.body).toContain('"finish_reason":"stop"');
      expect(final.body.trim().endsWith('data: [DONE]')).toBe(true);
      expect(run.stream.writes).toHaveLength(originalWrites);
      expect(transport.opened).toHaveLength(2);
    } finally {
      await server.close();
    }
  });

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
