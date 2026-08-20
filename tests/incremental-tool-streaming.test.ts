import { request as httpRequest, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import type {
  CompletionStreamEvent,
  CompletionUsage,
  CursorBackend,
  ToolCall,
} from '../src/backend/types.js';
import type { BridgeConfig } from '../src/config.js';
import { createCanonicalCases } from '../src/benchmark/cases.js';

const config: BridgeConfig = {
  host: '127.0.0.1',
  port: 0,
  apiKey: undefined,
  clientAuth: 'off',
  backend: 'mock',
  defaultModel: 'composer-2.5',
  workspaceMode: 'chat-only',
  realWorkspacePath: undefined,
  version: 'test',
};
const usage: CompletionUsage = {
  prompt_tokens: 11,
  completion_tokens: 7,
  total_tokens: 18,
};
const servers: Array<Awaited<ReturnType<typeof buildServer>>> = [];

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let settle: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: () => settle?.() };
}

function backend(events: () => AsyncGenerator<CompletionStreamEvent>): CursorBackend {
  return {
    type: 'mock',
    health: async () => ({ ok: true, type: 'mock', authConfigured: true }),
    listModels: async () => [
      { id: 'composer-2.5', object: 'model', created: 1, owned_by: 'cursor' },
    ],
    complete: async (request) => ({ content: 'unused', model: request.model, usage }),
    completeStream: events,
  };
}

async function streamingRequest(
  port: number,
  payload: Record<string, unknown>,
): Promise<IncomingMessage> {
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
    request.end(JSON.stringify(payload));
  });
}

function jsonFrames(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n\n')
    .filter((frame) => frame.startsWith('data: {'))
    .map((frame) => JSON.parse(frame.slice(6)) as Record<string, unknown>);
}

function choices(frame: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(frame.choices) ? (frame.choices as Array<Record<string, unknown>>) : [];
}

function reconstructCalls(frames: readonly Record<string, unknown>[]): ToolCall[] {
  const calls = new Map<number, ToolCall>();
  for (const frame of frames) {
    const delta = choices(frame)[0]?.delta;
    if (!delta || typeof delta !== 'object') continue;
    const toolCalls = (delta as { tool_calls?: unknown }).tool_calls;
    if (!Array.isArray(toolCalls)) continue;
    for (const raw of toolCalls) {
      if (!raw || typeof raw !== 'object') continue;
      const item = raw as {
        index?: unknown;
        id?: unknown;
        type?: unknown;
        function?: { name?: unknown; arguments?: unknown };
      };
      if (typeof item.index !== 'number') continue;
      const current = calls.get(item.index);
      calls.set(item.index, {
        id: typeof item.id === 'string' ? item.id : (current?.id ?? ''),
        type: 'function',
        function: {
          name:
            typeof item.function?.name === 'string'
              ? item.function.name
              : (current?.function.name ?? ''),
          arguments: `${current?.function.arguments ?? ''}${typeof item.function?.arguments === 'string' ? item.function.arguments : ''}`,
        },
      });
    }
  }
  return [...calls.entries()].sort(([left], [right]) => left - right).map(([, call]) => call);
}

async function startServer(cursorBackend: CursorBackend): Promise<{ readonly port: number }> {
  const server = await buildServer({ config, backend: cursorBackend });
  servers.push(server);
  await server.listen({ host: '127.0.0.1', port: 0 });
  return { port: (server.server.address() as AddressInfo).port };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('incremental OpenAI tool streaming', () => {
  it('reconstructs parallel calls before terminal without duplicate completion or marker leakage', async () => {
    const fragmentsSent = deferred();
    const releaseTerminal = deferred();
    const cursorBackend = backend(async function* () {
      yield { type: 'tool_call_start', index: 0, id: 'call_a', name: 'echo_value' };
      yield { type: 'tool_call_start', index: 1, id: 'call_b', name: 'echo_value' };
      yield { type: 'tool_call_arguments_delta', index: 0, id: 'call_a', delta: '{"value":' };
      yield {
        type: 'tool_call_arguments_delta',
        index: 1,
        id: 'call_b',
        delta: '{"value":"B"}',
      };
      yield { type: 'tool_call_arguments_delta', index: 0, id: 'call_a', delta: '"A"}' };
      yield {
        type: 'content',
        text: '[TOOL_CALLS: [{"function":{"name":"echo_value","arguments":{}}}]]',
      };
      fragmentsSent.resolve();
      await releaseTerminal.promise;
      const first: ToolCall = {
        id: 'call_a',
        type: 'function',
        function: { name: 'echo_value', arguments: '{"value":"A"}' },
      };
      const second: ToolCall = {
        id: 'call_b',
        type: 'function',
        function: { name: 'echo_value', arguments: '{"value":"B"}' },
      };
      yield { type: 'tool_call_complete', index: 0, call: first };
      yield { type: 'tool_call_complete', index: 1, call: second };
      yield { type: 'tool_call_complete', index: 1, call: second };
      yield { type: 'done', usage, is_error: false };
    });
    const { port } = await startServer(cursorBackend);
    const response = await streamingRequest(port, {
      model: 'composer-2.5',
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: 'call A and B' }],
      tools: [{ type: 'function', function: { name: 'echo_value', parameters: {} } }],
      parallel_tool_calls: true,
    });
    const chunks: Buffer[] = [];
    const ended = deferred();
    const earlyToolFrame = deferred();
    response.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).includes(Buffer.from('"tool_calls"'))) earlyToolFrame.resolve();
    });
    response.once('end', ended.resolve);
    await fragmentsSent.promise;
    const earlyDeadline = AbortSignal.timeout(500);
    const earlyResult = await Promise.race([
      earlyToolFrame.promise.then(() => 'tool_frame' as const),
      new Promise<'timeout'>((resolve) =>
        earlyDeadline.addEventListener('abort', () => resolve('timeout'), { once: true }),
      ),
    ]);

    releaseTerminal.resolve();
    await ended.promise;
    const body = Buffer.concat(chunks).toString('utf8');
    const frames = jsonFrames(body);
    const finishReasons = frames.flatMap((frame) =>
      choices(frame).map((choice) => choice.finish_reason),
    );

    expect(earlyResult).toBe('tool_frame');
    expect(body).not.toContain('[TOOL_CALLS:');
    expect(reconstructCalls(frames)).toEqual([
      {
        id: 'call_a',
        type: 'function',
        function: { name: 'echo_value', arguments: '{"value":"A"}' },
      },
      {
        id: 'call_b',
        type: 'function',
        function: { name: 'echo_value', arguments: '{"value":"B"}' },
      },
    ]);
    expect(finishReasons.filter((reason) => reason === 'tool_calls')).toHaveLength(1);
    expect(frames.find((frame) => choices(frame).length === 0)?.usage).toEqual(usage);
    expect(body.trim().endsWith('data: [DONE]')).toBe(true);
  });

  it('does not treat a provisional delta as an authoritative completed call', async () => {
    const cursorBackend = backend(async function* () {
      yield { type: 'tool_call_start', index: 0, id: 'call_a', name: 'echo_value' };
      yield {
        type: 'tool_call_arguments_delta',
        index: 0,
        id: 'call_a',
        delta: '{"value":"partial"}',
      };
      yield { type: 'done', usage, is_error: false };
    });
    const { port } = await startServer(cursorBackend);
    const response = await streamingRequest(port, {
      model: 'composer-2.5',
      stream: true,
      messages: [{ role: 'user', content: 'call once' }],
      tools: [{ type: 'function', function: { name: 'echo_value', parameters: {} } }],
    });
    const chunks: Buffer[] = [];
    const ended = deferred();
    response.on('data', (chunk: Buffer) => chunks.push(chunk));
    response.once('end', ended.resolve);
    await ended.promise;
    const body = Buffer.concat(chunks).toString('utf8');

    expect(body).toContain('"type":"backend_error"');
    expect(body).not.toContain('"finish_reason":"tool_calls"');
    expect(body).not.toContain('data: [DONE]');
  });

  it('labels validation-dependent required and forced cases as buffered only', () => {
    const cases = new Map(createCanonicalCases().map((testCase) => [testCase.id, testCase]));

    expect(cases.get('tool_auto_single')?.streamModes.yorha).toBe('incremental');
    expect(cases.get('tool_parallel_two')?.streamModes.yorha).toBe('incremental');
    expect(cases.get('toolChoice_required')?.streamModes.yorha).toBe('buffered');
    expect(cases.get('toolChoice_forced')?.streamModes.yorha).toBe('buffered');
    expect(cases.get('tool_schema_recovery')?.streamModes.yorha).toBe('buffered');
  });
});
