import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { CursorAuthProvider } from '../src/backend/cursor-api/auth.js';
import { encodeConnectFrame } from '../src/backend/cursor-api/connect-frame.js';
import { CursorApiBackend } from '../src/backend/cursor-api/index.js';
import { loadProtoDescriptors, ProtoCodec } from '../src/backend/cursor-api/protobuf.js';
import { mapCursorApiToolRequest } from '../src/backend/cursor-api/tool-wire-names.js';
import type { CursorApiTransport, CursorRunStream } from '../src/backend/cursor-api/transport.js';
import type { ChatCompletionRequest, CompletionStreamEvent } from '../src/backend/types.js';
import type { BridgeConfig } from '../src/config.js';
import {
  attachRequestTrace,
  createRequestTrace,
  traceRunOpen,
  type RequestTrace,
  type TraceRecord,
} from '../src/trace.js';

const config: BridgeConfig = {
  host: '127.0.0.1',
  port: 0,
  backend: 'cursor-api',
  defaultModel: 'composer-2.5',
  workspaceMode: 'chat-only',
  version: 'test',
};
const codec = new ProtoCodec(loadProtoDescriptors());
const request: ChatCompletionRequest = {
  model: 'composer-2.5',
  messages: [{ role: 'user', content: 'TASK_11_SENTINEL' }],
};

type RunScript = (stream: RunStream) => void;

class RunStream extends EventEmitter implements CursorRunStream {
  destroyed = false;
  writableEnded = false;
  #started = false;

  constructor(private readonly script: RunScript) {
    super();
  }

  write(): boolean {
    if (!this.#started) {
      this.#started = true;
      queueMicrotask(() => this.script(this));
    }
    return true;
  }

  destroy(error?: Error): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (error) this.emit('error', error);
    this.emit('close');
  }

  close(): void {
    if (this.writableEnded) return;
    this.writableEnded = true;
    this.emit('close');
  }
}

class ScriptedTransport implements CursorApiTransport {
  attempts = 0;

  constructor(private readonly scripts: readonly RunScript[]) {}

  async unary(path: string): Promise<Buffer> {
    if (path.includes('GetServerConfig')) {
      return codec.encode('aiserver.v1.GetServerConfigResponse', {
        agentUrlConfig: { agentnUrl: 'https://agent.test' },
      });
    }
    return Buffer.alloc(0);
  }

  async openRun(
    _baseUrl: string,
    _requestId: string,
    _accessToken?: string,
    trace?: RequestTrace,
  ): Promise<CursorRunStream> {
    const script = this.scripts[Math.min(this.attempts, this.scripts.length - 1)];
    this.attempts += 1;
    if (!script) throw new Error('missing Run script');
    traceRunOpen(trace, 'cursor-api');
    return new RunStream(script);
  }
}

function backend(transport: CursorApiTransport): CursorApiBackend {
  const auth = new CursorAuthProvider({ environment: {} });
  vi.spyOn(auth, 'getToken').mockResolvedValue('task-11-credential');
  return new CursorApiBackend(config, {
    auth,
    transport,
    environment: { CURSOR_BRIDGE_CURSOR_RETRY_BASE_MS: '1' },
    wait: async () => undefined,
  });
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

const goaway = (): Error =>
  Object.assign(new Error('GOAWAY received'), { code: 'ERR_HTTP2_GOAWAY_SESSION' });

const failBeforeOutput: RunScript = (stream) => {
  stream.emit('response', { ':status': 200 });
  stream.destroy(goaway());
};

const succeedWithSentinel: RunScript = (stream) => {
  stream.emit('response', { ':status': 200 });
  stream.emit(
    'data',
    Buffer.concat([
      update('textDelta', { text: 'TASK_11_SENTINEL' }),
      update('turnEnded', { inputTokens: 3, outputTokens: 2 }),
      encodeConnectFrame(Buffer.alloc(0), { trailer: true }),
    ]),
  );
};

async function collect(
  cursor: CursorApiBackend,
  candidate: ChatCompletionRequest,
): Promise<CompletionStreamEvent[]> {
  const events: CompletionStreamEvent[] = [];
  for await (const event of cursor.completeStream(candidate)) events.push(event);
  return events;
}

describe('task 11 retry visibility lifecycle', () => {
  it('retries one pre-output GOAWAY as two Runs and emits one client result', async () => {
    const transport = new ScriptedTransport([failBeforeOutput, succeedWithSentinel]);
    const records: TraceRecord[] = [];
    const tracedRequest = structuredClone(request);
    const trace = createRequestTrace({
      environment: { CURSOR_BRIDGE_TRACE: '1' },
      requestId: 'task-11-pre-output',
      model: request.model,
      sink: (record) => records.push(record),
    });
    attachRequestTrace(tracedRequest, trace);

    const events = await collect(backend(transport), tracedRequest);

    expect(transport.attempts).toBe(2);
    expect(events.filter((event) => event.type === 'content')).toEqual([
      { type: 'content', text: 'TASK_11_SENTINEL' },
    ]);
    expect(records.filter((record) => record.stage === 'run_open')).toHaveLength(2);
    expect(records.filter((record) => record.stage === 'retry')).toHaveLength(1);
  });

  it('surfaces a second pre-output GOAWAY after exactly one retry', async () => {
    const transport = new ScriptedTransport([failBeforeOutput]);

    await expect(collect(backend(transport), request)).rejects.toThrow('GOAWAY');
    expect(transport.attempts).toBe(2);
  });

  it('suppresses stream data emitted after trailer settlement', async () => {
    // Given: one Run emits a successful trailer, then a forbidden late data chunk.
    const transport = new ScriptedTransport([
      (stream) => {
        stream.emit('response', { ':status': 200 });
        stream.emit(
          'data',
          Buffer.concat([
            update('textDelta', { text: 'TASK_11_SENTINEL' }),
            update('turnEnded', { inputTokens: 3, outputTokens: 2 }),
            encodeConnectFrame(Buffer.alloc(0), { trailer: true }),
          ]),
        );
        stream.emit('data', update('textDelta', { text: 'FORBIDDEN_LATE_SENTINEL' }));
      },
    ]);

    // When: the client drains the completed stream.
    const events = await collect(backend(transport), request);

    // Then: only data delivered before settlement is observable.
    expect(events.filter((event) => event.type === 'content')).toEqual([
      { type: 'content', text: 'TASK_11_SENTINEL' },
    ]);
    expect(transport.attempts).toBe(1);
  });

  it('does not retry after mixed text and tool start, args, or completion become visible', async () => {
    const toolRequest: ChatCompletionRequest = {
      ...request,
      tools: [
        {
          type: 'function',
          function: { name: 'echo_value', parameters: { type: 'object' } },
        },
      ],
      tool_choice: 'auto',
    };
    const wireName = mapCursorApiToolRequest(toolRequest).request.tools?.[0]?.function.name;
    if (!wireName) throw new Error('missing wire tool name');
    const transport = new ScriptedTransport([
      (stream) => {
        stream.emit('response', { ':status': 200 });
        stream.emit(
          'data',
          Buffer.concat([
            update('textDelta', { text: 'TASK_11_SENTINEL' }),
            update('toolCallStarted', {
              callId: 'envelope-1',
              toolCall: {
                tool: {
                  case: 'mcpToolCall',
                  value: {
                    args: {
                      name: wireName,
                      toolName: wireName,
                      providerIdentifier: 'bridge',
                      toolCallId: 'call-1',
                      args: {},
                    },
                  },
                },
                toolCallId: 'call-1',
              },
            }),
            update('partialToolCall', {
              callId: 'envelope-1',
              argsTextDelta: '{"value":"TASK_11_SENTINEL"}',
            }),
          ]),
        );
        stream.destroy(goaway());
      },
    ]);
    const events: CompletionStreamEvent[] = [];

    await expect(
      (async () => {
        for await (const event of backend(transport).completeStream(toolRequest))
          events.push(event);
      })(),
    ).rejects.toThrow('GOAWAY');

    expect(transport.attempts).toBe(1);
    expect(events.map((event) => event.type)).toEqual([
      'content',
      'tool_call_start',
      'tool_call_arguments_delta',
    ]);
    expect(events.filter((event) => event.type === 'content')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'tool_call_start')).toHaveLength(1);
  });
});
