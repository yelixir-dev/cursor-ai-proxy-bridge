import { EventEmitter } from 'node:events';
import { vi } from 'vitest';
import { CursorAuthProvider } from '../../src/backend/cursor-api/auth.js';
import { encodeConnectFrame } from '../../src/backend/cursor-api/connect-frame.js';
import { CursorCredentialRouter } from '../../src/backend/cursor-api/credentials.js';
import { CursorApiBackend } from '../../src/backend/cursor-api/index.js';
import {
  jsonToProtoValue,
  loadProtoDescriptors,
  ProtoCodec,
} from '../../src/backend/cursor-api/protobuf.js';
import { mapCursorApiToolRequest } from '../../src/backend/cursor-api/tool-wire-names.js';
import type {
  CursorApiTransport,
  CursorRunStream,
} from '../../src/backend/cursor-api/transport.js';
import type { ChatCompletionRequest, CompletionStreamEvent } from '../../src/backend/types.js';
import type { BridgeConfig } from '../../src/config.js';

const config: BridgeConfig = {
  host: '127.0.0.1',
  port: 0,
  backend: 'cursor-api',
  defaultModel: 'composer-2.5',
  workspaceMode: 'chat-only',
  version: 'test',
};
const codec = new ProtoCodec(loadProtoDescriptors());

export class ScriptedStream extends EventEmitter implements CursorRunStream {
  destroyed = false;
  writableEnded = false;
  #started = false;

  constructor(private readonly script: (stream: ScriptedStream) => void) {
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
    if (error && this.listenerCount('error') > 0) this.emit('error', error);
    this.emit('close');
  }

  close(): void {
    if (this.writableEnded) return;
    this.writableEnded = true;
    this.emit('close');
  }
}

interface OpenedRun {
  readonly stream: ScriptedStream;
  readonly accessToken: string;
}

export class ScriptedTransport implements CursorApiTransport {
  readonly opened: OpenedRun[] = [];
  readonly #openedPromise = Promise.withResolvers<OpenedRun>();

  constructor(private readonly script: (stream: ScriptedStream, accessToken: string) => void) {}

  get attempts(): readonly string[] {
    return this.opened.map((run) => run.accessToken);
  }

  get firstRun(): Promise<OpenedRun> {
    return this.#openedPromise.promise;
  }

  async unary(path: string): Promise<Buffer> {
    if (path.includes('GetServerConfig')) {
      return codec.encode('aiserver.v1.GetServerConfigResponse', {
        agentUrlConfig: { agentnUrl: 'https://agent.test' },
      });
    }
    return Buffer.alloc(0);
  }

  async openRun(_baseUrl: string, _requestId: string, accessToken = ''): Promise<CursorRunStream> {
    const stream = new ScriptedStream((active) => this.script(active, accessToken));
    const run: OpenedRun = { stream, accessToken };
    this.opened.push(run);
    this.#openedPromise.resolve(run);
    return stream;
  }
}

export function update(caseName: string, value: Record<string, unknown>): Buffer {
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

export const trailer = (): Buffer => encodeConnectFrame(Buffer.from('{}'), { trailer: true });

export function toolCall(wireName: string, id: string, value: string): Record<string, unknown> {
  return {
    name: wireName,
    toolName: wireName,
    providerIdentifier: 'bridge',
    toolCallId: id,
    args: { value: jsonToProtoValue(value) },
  };
}

export function parallelToolRequest(): ChatCompletionRequest {
  return {
    model: 'composer-2.5',
    messages: [{ role: 'user', content: 'call both tools' }],
    tools: [
      {
        type: 'function',
        function: {
          name: 'echo_value',
          parameters: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
          },
        },
      },
    ],
    tool_choice: 'auto',
    parallel_tool_calls: true,
  };
}

export function callBatch(wireName: string, id: string, value: string): Buffer {
  const argumentsJson = JSON.stringify({ value });
  return Buffer.concat([
    update('toolCallStarted', {
      callId: id,
      toolCall: {
        tool: { case: 'mcpToolCall', value: { args: toolCall(wireName, id, '') } },
        toolCallId: id,
      },
    }),
    update('partialToolCall', { callId: id, argsTextDelta: argumentsJson }),
    exec(toolCall(wireName, id, value)),
  ]);
}

export function backend(
  transport: CursorApiTransport,
  credentials = [{ id: 'only', apiKey: 'only-token' }],
): CursorApiBackend {
  const auth = new CursorAuthProvider({ environment: {} });
  vi.spyOn(auth, 'getToken').mockImplementation(async (credential) => credential?.apiKey ?? '');
  return new CursorApiBackend(config, {
    auth,
    transport,
    credentialRouter: new CursorCredentialRouter({ credentials }),
    environment: { CURSOR_BRIDGE_CURSOR_RETRY_BASE_MS: '1' },
    wait: async () => undefined,
  });
}

export async function collect(
  cursor: CursorApiBackend,
  request: ChatCompletionRequest,
): Promise<CompletionStreamEvent[]> {
  const events: CompletionStreamEvent[] = [];
  for await (const event of cursor.completeStream(request)) events.push(event);
  return events;
}

export function wireToolName(request: ChatCompletionRequest): string {
  const name = mapCursorApiToolRequest(request).request.tools?.[0]?.function.name;
  if (!name) throw new Error('missing wire tool name');
  return name;
}
