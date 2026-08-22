import { EventEmitter } from 'node:events';
import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { CursorAuthProvider } from '../src/backend/cursor-api/auth.js';
import { ConnectRpcError, encodeConnectFrame } from '../src/backend/cursor-api/connect-frame.js';
import { CursorCredentialRouter } from '../src/backend/cursor-api/credentials.js';
import { CursorApiBackend } from '../src/backend/cursor-api/index.js';
import {
  jsonToProtoValue,
  loadProtoDescriptors,
  ProtoCodec,
} from '../src/backend/cursor-api/protobuf.js';
import { mapCursorApiToolRequest } from '../src/backend/cursor-api/tool-wire-names.js';
import {
  type CursorApiTransport,
  type CursorRunStream,
  NodeCursorApiTransport,
} from '../src/backend/cursor-api/transport.js';
import type { ChatCompletionRequest, CompletionStreamEvent } from '../src/backend/types.js';
import type { BridgeConfig } from '../src/config.js';

const config: BridgeConfig = {
  host: '127.0.0.1',
  port: 0,
  backend: 'cursor-api',
  defaultModel: 'composer-2.5',
  workspaceMode: 'chat-only',
  version: 'test',
};
const codec = new ProtoCodec(loadProtoDescriptors());

type RunScript = (stream: ScriptedStream, accessToken: string) => void;

class ScriptedStream extends EventEmitter implements CursorRunStream {
  destroyed = false;
  writableEnded = false;
  private started = false;

  constructor(
    private readonly accessToken: string,
    private readonly script: RunScript,
  ) {
    super();
  }

  write(chunk: Uint8Array): boolean {
    this.emit('write', Buffer.from(chunk));
    if (!this.started) {
      this.started = true;
      queueMicrotask(() => this.script(this, this.accessToken));
    }
    return true;
  }

  end(): void {
    if (this.destroyed || this.writableEnded) return;
    this.writableEnded = true;
  }

  destroy(error?: Error): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (error && this.listenerCount('error') > 0) this.emit('error', error);
    this.emit('close');
  }

  close(): void {
    if (this.writableEnded) return;
    this.writableEnded = true;
    this.emit('close');
  }
}

class ScriptedTransport implements CursorApiTransport {
  readonly attempts: string[] = [];

  constructor(private readonly script: RunScript) {}

  async unary(path: string): Promise<Buffer> {
    if (path.includes('GetServerConfig')) {
      return codec.encode('aiserver.v1.GetServerConfigResponse', {
        agentUrlConfig: { agentnUrl: 'https://agent.test' },
      });
    }
    return Buffer.alloc(0);
  }

  async openRun(_baseUrl: string, _requestId: string, accessToken = ''): Promise<CursorRunStream> {
    this.attempts.push(accessToken);
    return new ScriptedStream(accessToken, this.script);
  }
}

function update(caseName: string, value: Record<string, unknown>): Buffer {
  return encodeConnectFrame(
    codec.encode('agent.v1.AgentServerMessage', {
      message: {
        case: 'interactionUpdate',
        value: { message: { case: caseName, value } },
      },
    }),
  );
}

function exec(value: Record<string, unknown>): Buffer {
  return encodeConnectFrame(
    codec.encode('agent.v1.AgentServerMessage', {
      message: {
        case: 'execServerMessage',
        value: {
          id: 1,
          execId: String(value.toolCallId),
          message: { case: 'mcpArgs', value },
        },
      },
    }),
  );
}

function backend(
  transport: CursorApiTransport,
  credentials = [{ id: 'only', apiKey: 'only-token' }],
): CursorApiBackend {
  const auth = new CursorAuthProvider({ environment: {} });
  vi.spyOn(auth, 'getToken').mockImplementation(async (credential) => credential?.apiKey ?? '');
  return new CursorApiBackend(config, {
    auth,
    transport,
    credentialRouter: new CursorCredentialRouter({ credentials }),
    environment: {
      CURSOR_BRIDGE_CURSOR_RETRY_BASE_MS: '1',
      CURSOR_BRIDGE_STICKY_SETTLE_MS: '5',
    },
    wait: async () => undefined,
  });
}

async function collect(
  cursor: CursorApiBackend,
  request: ChatCompletionRequest,
): Promise<CompletionStreamEvent[]> {
  const events: CompletionStreamEvent[] = [];
  for await (const event of cursor.completeStream(request)) events.push(event);
  return events;
}

function toolCall(name: string, id: string, value: string): Record<string, unknown> {
  return {
    name,
    toolName: name,
    providerIdentifier: 'bridge',
    toolCallId: id,
    args: { value: jsonToProtoValue(value) },
  };
}

describe('cursor-api F2 lifecycle boundaries', () => {
  it('keeps the successful failover Run sticky through the client tool result', async () => {
    // Given: the first credential fails before output, the second credential
    // opens a Run and parks on one external tool call.
    const request: ChatCompletionRequest = {
      model: 'composer-2.5',
      messages: [{ role: 'user', content: 'look up the seed' }],
      tools: [
        {
          type: 'function',
          function: { name: 'echo_value', parameters: { type: 'object' } },
        },
      ],
      tool_choice: 'auto',
      parallel_tool_calls: false,
    };
    const wireName = mapCursorApiToolRequest(request).request.tools?.[0]?.function.name;
    if (!wireName) throw new Error('missing wire tool name');
    const external = toolCall(wireName, 'call-1', 'seed');
    let successfulStream: ScriptedStream | undefined;
    const replacementOpened = Promise.withResolvers<'new-run'>();
    const transport = new ScriptedTransport((stream, accessToken) => {
      if (accessToken === 'first-token') {
        stream.emit('response', { ':status': 401 });
        return;
      }
      stream.emit('response', { ':status': 200 });
      if (successfulStream) {
        replacementOpened.resolve('new-run');
        stream.emit(
          'data',
          Buffer.concat([
            update('textDelta', { text: 'replacement' }),
            update('turnEnded', { inputTokens: 1, outputTokens: 1 }),
            encodeConnectFrame(Buffer.alloc(0), { trailer: true }),
          ]),
        );
        return;
      }
      successfulStream = stream;
      stream.emit(
        'data',
        Buffer.concat([
          update('toolCallStarted', {
            callId: 'call-1',
            toolCall: {
              tool: { case: 'mcpToolCall', value: { args: external } },
              toolCallId: 'call-1',
            },
          }),
          update('partialToolCall', {
            callId: 'call-1',
            argsTextDelta: '{"value":"seed"}',
          }),
          exec(external),
        ]),
      );
    });
    const cursor = backend(transport, [
      { id: 'first', apiKey: 'first-token' },
      { id: 'second', apiKey: 'second-token' },
    ]);
    const first = await collect(cursor, request);
    const completed = first.find((event) => event.type === 'tool_call_complete');
    if (completed?.type !== 'tool_call_complete') throw new Error('missing failover tool call');
    const active = successfulStream;
    if (!active) throw new Error('missing successful Run stream');
    expect(transport.attempts).toEqual(['first-token', 'second-token']);

    // When: the client returns the tool result.
    const resumed = Promise.withResolvers<'resumed'>();
    active.once('write', () => resumed.resolve('resumed'));
    const continuation = collect(cursor, {
      ...request,
      messages: [
        ...request.messages,
        { role: 'assistant', content: '', tool_calls: [completed.call] },
        { role: 'tool', tool_call_id: completed.call.id, content: 'seed result' },
      ],
    });

    // Then: it resumes the successful second-credential stream without
    // entering credential routing or opening a third Run.
    expect(await Promise.race([resumed.promise, replacementOpened.promise])).toBe('resumed');
    active.emit(
      'data',
      Buffer.concat([
        update('textDelta', { text: 'continued on second' }),
        update('turnEnded', { inputTokens: 3, outputTokens: 2 }),
        encodeConnectFrame(Buffer.alloc(0), { trailer: true }),
      ]),
    );
    const continued = await continuation;
    expect(continued).toContainEqual({ type: 'content', text: 'continued on second' });
    expect(continued.at(-1)).toMatchObject({
      type: 'done',
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      usage_source: 'turnEnded',
    });
    expect(transport.attempts).toEqual(['first-token', 'second-token']);
  });

  it('keeps a parallel Run open through a later stream data event', async () => {
    // Given: call B is announced in a separate data event after call A completes,
    // and the upstream stream ends with a Connect trailer.
    const request: ChatCompletionRequest = {
      model: 'composer-2.5',
      messages: [{ role: 'user', content: 'call both' }],
      tools: [
        {
          type: 'function',
          function: { name: 'echo_value', parameters: { type: 'object' } },
        },
      ],
      tool_choice: 'auto',
      parallel_tool_calls: true,
    };
    const wireName = mapCursorApiToolRequest(request).request.tools?.[0]?.function.name;
    if (!wireName) throw new Error('missing wire tool name');
    const first = toolCall(wireName, 'call-a', 'A');
    const second = toolCall(wireName, 'call-b', 'B');
    const transport = new ScriptedTransport((stream) => {
      stream.emit('response', { ':status': 200 });
      stream.emit(
        'data',
        Buffer.concat([
          update('toolCallStarted', {
            callId: 'call-a',
            toolCall: {
              tool: { case: 'mcpToolCall', value: { args: first } },
              toolCallId: 'call-a',
            },
          }),
          update('partialToolCall', { callId: 'call-a', argsTextDelta: '{"value":"A"}' }),
          exec(first),
        ]),
      );
      setImmediate(() => {
        stream.emit(
          'data',
          Buffer.concat([
            update('toolCallStarted', {
              callId: 'call-b',
              toolCall: {
                tool: { case: 'mcpToolCall', value: { args: second } },
                toolCallId: 'call-b',
              },
            }),
            update('partialToolCall', { callId: 'call-b', argsTextDelta: '{"value":"B"}' }),
            exec(second),
            encodeConnectFrame(Buffer.from('{}'), { trailer: true }),
          ]),
        );
      });
    });

    // When: the client consumes the incremental stream.
    const events = await collect(backend(transport), request);

    // Then: starts and argument deltas remain incremental, and the final set is exact.
    expect(events.slice(0, 4).map((event) => event.type)).toEqual([
      'tool_call_start',
      'tool_call_arguments_delta',
      'tool_call_start',
      'tool_call_arguments_delta',
    ]);
    expect(
      events.filter((event) => event.type === 'tool_call_complete').map((event) => event.call.id),
    ).toEqual(['call-a', 'call-b']);
    expect(transport.attempts).toEqual(['only-token']);
  });

  it('never changes credentials after semantic output and fails over on the next request', async () => {
    // Given: the first credential emits text, then receives an auth trailer.
    const transport = new ScriptedTransport((stream, accessToken) => {
      stream.emit('response', { ':status': 200 });
      if (accessToken === 'first-token') {
        stream.emit('data', update('textDelta', { text: 'VISIBLE_ON_FIRST' }));
        queueMicrotask(() =>
          stream.emit(
            'data',
            encodeConnectFrame(
              Buffer.from(
                JSON.stringify({
                  error: { code: 'unauthenticated', message: 'expired credential' },
                }),
              ),
              { trailer: true },
            ),
          ),
        );
        return;
      }
      stream.emit(
        'data',
        Buffer.concat([
          update('textDelta', { text: 'SECOND_REQUEST' }),
          encodeConnectFrame(Buffer.alloc(0), { trailer: true }),
        ]),
      );
    });
    const cursor = backend(transport, [
      { id: 'first', apiKey: 'first-token' },
      { id: 'second', apiKey: 'second-token' },
    ]);
    const request: ChatCompletionRequest = {
      model: 'composer-2.5',
      messages: [{ role: 'user', content: 'credential boundary' }],
    };
    const visible: CompletionStreamEvent[] = [];

    // When: the first request crosses its visible boundary before authentication fails.
    let failure: unknown;
    try {
      for await (const event of cursor.completeStream(request)) visible.push(event);
    } catch (error) {
      failure = error;
    }

    // Then: it fails without replay, while the disabled credential fails over next request.
    expect(failure).toBeInstanceOf(ConnectRpcError);
    expect(visible).toEqual([{ type: 'content', text: 'VISIBLE_ON_FIRST' }]);
    expect(transport.attempts).toEqual(['first-token']);
    const next = await collect(cursor, request);
    expect(next.filter((event) => event.type === 'content')).toEqual([
      { type: 'content', text: 'SECOND_REQUEST' },
    ]);
    expect(transport.attempts).toEqual(['first-token', 'second-token']);
  });
});

describe('cursor-api unary response limits', () => {
  const limit = 4;

  it('rejects a declared compressed body overflow with a typed failure and cancellation', async () => {
    // Given: the response declares more compressed bytes than the transport ceiling.
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from('small'));
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const transport = new NodeCursorApiTransport({
      auth: new CursorAuthProvider({ environment: { CURSOR_AUTH_TOKEN: 'token' } }),
      clientVersion: 'test',
      maxUnaryCompressedBytes: limit,
      maxUnaryDecompressedBytes: limit,
      fetch: async () => new Response(body, { headers: { 'content-length': String(limit + 1) } }),
    });

    // When/Then: overflow is typed and the unread body is cancelled.
    await expect(transport.unary('/test', Buffer.alloc(0))).rejects.toMatchObject({
      name: 'UnaryBodyLimitError',
      kind: 'compressed',
      limit,
    });
    expect(cancelled).toBe(true);
  });

  it('rejects gzip expansion beyond the decompressed ceiling with a typed failure', async () => {
    // Given: a small gzip payload expands beyond the decompressed ceiling.
    const compressed = gzipSync(Buffer.alloc(limit + 1, 0x61));
    const transport = new NodeCursorApiTransport({
      auth: new CursorAuthProvider({ environment: { CURSOR_AUTH_TOKEN: 'token' } }),
      clientVersion: 'test',
      maxUnaryCompressedBytes: compressed.length,
      maxUnaryDecompressedBytes: limit,
      fetch: async () =>
        new Response(compressed, {
          headers: {
            'content-encoding': 'gzip',
            'content-length': String(compressed.length),
          },
        }),
    });

    // When/Then: gzip decompression is bounded independently of wire bytes.
    await expect(transport.unary('/test', Buffer.alloc(0))).rejects.toMatchObject({
      name: 'UnaryBodyLimitError',
      kind: 'decompressed',
      limit,
    });
  });
});
