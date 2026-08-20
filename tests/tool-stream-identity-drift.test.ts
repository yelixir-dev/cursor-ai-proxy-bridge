import { request as httpRequest, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CursorToolStream,
  ToolCallReconciliationError,
} from '../src/backend/cursor-api/tool-stream.js';
import { jsonToProtoValue } from '../src/backend/cursor-api/protobuf.js';
import type {
  CompletionStreamEvent,
  CompletionUsage,
  CursorBackend,
  ToolCall,
} from '../src/backend/types.js';
import type { BridgeConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';

const config: BridgeConfig = {
  host: '127.0.0.1',
  port: 0,
  apiKey: undefined,
  clientAuth: 'off',
  backend: 'mock',
  defaultModel: 'composer-2.5',
  workspaceMode: 'chat-only',
  realWorkspacePath: undefined,
  version: 'r1-test',
};
const usage: CompletionUsage = {
  prompt_tokens: 8,
  completion_tokens: 4,
  total_tokens: 12,
};
const servers: Array<Awaited<ReturnType<typeof buildServer>>> = [];

function nativeToolCall(id: string, name: string, value: string): Record<string, unknown> {
  return {
    tool: {
      case: 'mcpToolCall',
      value: {
        args: {
          name,
          toolName: name,
          providerIdentifier: 'bridge',
          toolCallId: id,
          args: { value: jsonToProtoValue(value) },
        },
      },
    },
    toolCallId: id,
  };
}

function backend(events: readonly CompletionStreamEvent[], runs: { count: number }): CursorBackend {
  return {
    type: 'mock',
    health: async () => ({ ok: true, type: 'mock', authConfigured: true }),
    listModels: async () => [
      { id: 'composer-2.5', object: 'model', created: 1, owned_by: 'cursor' },
    ],
    complete: async (request) => ({ content: 'unused', model: request.model, usage }),
    completeStream: async function* () {
      runs.count += 1;
      for (const event of events) yield event;
    },
  };
}

async function streamingRequest(port: number): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      },
      resolve,
    );
    request.once('error', reject);
    request.end(
      JSON.stringify({
        model: 'composer-2.5',
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: 'user', content: 'parallel identity drift' }],
        tools: [{ type: 'function', function: { name: 'echo_value', parameters: {} } }],
        parallel_tool_calls: true,
      }),
    );
  });
}

function reconstructCalls(body: string): ToolCall[] {
  const calls = new Map<number, ToolCall>();
  for (const frame of body.split('\n\n')) {
    if (!frame.startsWith('data: {')) continue;
    const parsed = JSON.parse(frame.slice(6)) as {
      choices?: Array<{
        delta?: {
          tool_calls?: Array<{
            index: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
      }>;
    };
    for (const item of parsed.choices?.[0]?.delta?.tool_calls ?? []) {
      const current = calls.get(item.index);
      calls.set(item.index, {
        id: item.id ?? current?.id ?? '',
        type: 'function',
        function: {
          name: item.function?.name ?? current?.function.name ?? '',
          arguments: `${current?.function.arguments ?? ''}${item.function?.arguments ?? ''}`,
        },
      });
    }
  }
  return [...calls.entries()].sort(([left], [right]) => left - right).map(([, call]) => call);
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('Cursor tool stream identity drift', () => {
  it('freezes exposed parallel identities when authoritative inner ids drift', async () => {
    const streamed: CompletionStreamEvent[] = [];
    const toolStream = new CursorToolStream(
      (event) => {
        streamed.push(event);
        return true;
      },
      new Set(['echo_value']),
      Number.POSITIVE_INFINITY,
    );
    const firstArgs = '{"value":"A"}';
    const secondArgs = JSON.stringify({ value: 'B'.repeat(49) });
    expect(Buffer.byteLength(secondArgs)).toBe(61);
    toolStream.start({
      callId: 'envelope_a',
      toolCall: nativeToolCall('call_a_start', 'echo_value', ''),
    });
    toolStream.start({
      callId: 'envelope_b',
      toolCall: nativeToolCall('call_b_start', 'echo_value', ''),
    });
    toolStream.partial({ callId: 'envelope_a', argsTextDelta: firstArgs });
    toolStream.partial({ callId: 'envelope_b', argsTextDelta: secondArgs });
    toolStream.completeExec({
      name: 'echo_value',
      toolName: 'echo_value',
      providerIdentifier: 'bridge',
      toolCallId: 'call_a_start',
      args: { value: jsonToProtoValue('A') },
    });
    toolStream.completeUpdate({
      callId: 'envelope_a',
      toolCall: nativeToolCall('call_a_start', 'echo_value', 'A'),
    });
    toolStream.completeExec({
      name: 'echo_value',
      toolName: 'echo_value',
      providerIdentifier: 'bridge',
      toolCallId: 'call_b_final',
      args: { value: jsonToProtoValue('B'.repeat(49)) },
    });
    const driftedCompletion = {
      callId: 'envelope_b',
      toolCall: nativeToolCall('call_b_final', 'echo_value', 'B'.repeat(49)),
    };
    toolStream.completeUpdate(driftedCompletion);
    toolStream.completeUpdate(driftedCompletion);
    toolStream.completeExec({
      name: 'echo_value',
      toolName: 'echo_value',
      providerIdentifier: 'bridge',
      toolCallId: 'call_b_exec_late',
      args: { value: jsonToProtoValue('B'.repeat(49)) },
    });
    for (const [index, call] of toolStream.completedCalls().entries()) {
      streamed.push({ type: 'tool_call_complete', index, call });
    }
    streamed.push({ type: 'done', usage, is_error: false });
    const runs = { count: 0 };
    const server = await buildServer({ config, backend: backend(streamed, runs) });
    servers.push(server);
    await server.listen({ host: '127.0.0.1', port: 0 });
    const port = (server.server.address() as AddressInfo).port;
    const response = await streamingRequest(port);
    const chunks: Buffer[] = [];
    for await (const chunk of response) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString('utf8');
    const frames = body
      .split('\n\n')
      .filter((frame) => frame.startsWith('data: {'))
      .map((frame) => JSON.parse(frame.slice(6)) as Record<string, unknown>);

    expect(response.statusCode).toBe(200);
    expect(reconstructCalls(body)).toEqual([
      {
        id: 'call_a_start',
        type: 'function',
        function: { name: 'echo_value', arguments: firstArgs },
      },
      {
        id: 'call_b_start',
        type: 'function',
        function: { name: 'echo_value', arguments: secondArgs },
      },
    ]);
    expect(
      streamed.filter((event) => event.type === 'tool_call_complete').map((event) => event.call.id),
    ).toEqual(['call_a_start', 'call_b_start']);
    expect(body.match(/"finish_reason":"tool_calls"/g)).toHaveLength(1);
    expect(
      frames.find((frame) => Array.isArray(frame.choices) && frame.choices.length === 0),
    ).toMatchObject({ usage });
    expect(body).not.toContain('[TOOL_CALLS:');
    expect(body).not.toContain('backend_error');
    expect(body.trim().endsWith('data: [DONE]')).toBe(true);
    expect(runs.count).toBe(1);
  });

  it('allows an unexposed slot to initialize from authoritative identity', () => {
    const toolStream = new CursorToolStream(undefined, new Set(['echo_value']), 1);
    toolStream.start({
      callId: 'envelope',
      toolCall: nativeToolCall('provisional', 'echo_value', ''),
    });
    toolStream.completeUpdate({
      callId: 'envelope',
      toolCall: nativeToolCall('authoritative', 'echo_value', 'value'),
    });

    expect(toolStream.completedCalls()[0]?.id).toBe('authoritative');
    expect(toolStream.emitted).toBe(false);
  });

  it('rejects authoritative name drift for an exposed envelope', () => {
    const toolStream = new CursorToolStream(() => true, new Set(['echo_value', 'lookup_code']), 1);
    toolStream.start({
      callId: 'envelope',
      toolCall: nativeToolCall('call_start', 'echo_value', ''),
    });

    expect(() =>
      toolStream.completeUpdate({
        callId: 'envelope',
        toolCall: nativeToolCall('call_final', 'lookup_code', 'value'),
      }),
    ).toThrow(ToolCallReconciliationError);
  });
});
