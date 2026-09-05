import { EventEmitter } from 'node:events';
import { fixtureNativeContext } from './support/native-context-fixture.js';
import { arrayAt, bufferAt, objectAt, valueAt } from './support/protobuf-values.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import type { OutgoingHttpHeaders } from 'node:http2';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CursorAuthProvider } from '../src/backend/cursor-api/auth.js';
import {
  ConnectFrameDecoder,
  ConnectRpcError,
  encodeConnectFrame,
} from '../src/backend/cursor-api/connect-frame.js';
import { buildCursorHistory, type CursorHistory } from '../src/backend/cursor-api/history.js';
import {
  CURSOR_API_STARTUP_SEQUENCE,
  CursorApiBackend,
  isRetryableCursorTransportError,
} from '../src/backend/cursor-api/index.js';
import {
  mapRequestedModels,
  mapUsableModels,
  nativeToolBatchComplete,
  requestContextResult,
  runRequestMessage,
} from '../src/backend/cursor-api/mapper.js';
import {
  jsonToProtoValue,
  loadProtoDescriptors,
  ProtoCodec,
  type ProtoDescriptorSet,
  type ProtoFieldDescriptor,
} from '../src/backend/cursor-api/protobuf.js';
import { mapCursorApiToolRequest } from '../src/backend/cursor-api/tool-wire-names.js';
import {
  CURSOR_BOOTSTRAP_UNARY_HEADER_NAMES,
  CURSOR_RUN_HEADER_NAMES,
  CURSOR_UNARY_HEADER_NAMES,
  type CursorApiTransport,
  type CursorRunStream,
  NodeCursorApiTransport,
} from '../src/backend/cursor-api/transport.js';
import { ToolHistoryValidationError } from '../src/backend/tool-history.js';
import type {
  ChatCompletionRequest,
  CompletionStreamEvent,
  CursorBackend,
  ToolCall,
} from '../src/backend/types.js';
import type { BridgeConfig } from '../src/config.js';
import { buildServer, flattenMessageContent } from '../src/server.js';

const scalar = (
  no: number,
  localName: string,
  type: number,
  options: Partial<Extract<ProtoFieldDescriptor, { kind: 'scalar' }>> = {},
): ProtoFieldDescriptor => ({
  no,
  name: localName,
  localName,
  kind: 'scalar',
  scalar: type,
  repeated: false,
  ...options,
});
const message = (
  no: number,
  localName: string,
  type: string,
  options: Partial<Extract<ProtoFieldDescriptor, { kind: 'message' }>> = {},
): ProtoFieldDescriptor => ({
  no,
  name: localName,
  localName,
  kind: 'message',
  message: type,
  repeated: false,
  ...options,
});
const oneof = (no: number, localName: string, type: string, group = 'message') =>
  message(no, localName, type, { oneof: group });
const fields = (...items: ProtoFieldDescriptor[]) => ({ fields: items });

const descriptors: ProtoDescriptorSet = {
  format: 1,
  bundleVersion: 'test-version',
  clientVersion: 'cli-test-version',
  roots: [],
  services: [],
  messages: {
    'aiserver.v1.GetServerConfigRequest': fields(),
    'aiserver.v1.GetServerConfigResponse': fields(
      message(27, 'agentUrlConfig', 'aiserver.v1.AgentUrlConfig'),
    ),
    'aiserver.v1.AgentUrlConfig': fields(scalar(1, 'agentUrl', 9), scalar(2, 'agentnUrl', 9)),
    'agent.v1.GetUsableModelsRequest': fields(),
    'agent.v1.AgentClientMessage': fields(
      oneof(1, 'runRequest', 'agent.v1.AgentRunRequest'),
      oneof(2, 'execClientMessage', 'agent.v1.ExecClientMessage'),
      oneof(3, 'kvClientMessage', 'agent.v1.KvClientMessage'),
      oneof(5, 'execClientControlMessage', 'agent.v1.ExecClientControlMessage'),
      oneof(7, 'clientHeartbeat', 'agent.v1.ClientHeartbeat'),
    ),
    'agent.v1.ExecClientControlMessage': fields(
      oneof(1, 'streamClose', 'agent.v1.ExecClientStreamClose'),
    ),
    'agent.v1.ExecClientStreamClose': fields(scalar(1, 'id', 13)),
    'agent.v1.AgentRunRequest': fields(
      message(1, 'conversationState', 'agent.v1.ConversationStateStructure'),
      message(2, 'action', 'agent.v1.ConversationAction'),
      message(9, 'requestedModel', 'agent.v1.RequestedModel'),
      scalar(5, 'conversationId', 9),
      scalar(16, 'conversationGroupId', 9),
      scalar(25, 'runId', 9),
    ),
    'agent.v1.Empty': fields(),
    'agent.v1.ConversationStateStructure': fields(
      scalar(1, 'rootPromptMessagesJson', 12, { repeated: true }),
      scalar(8, 'turns', 12, { repeated: true }),
    ),
    'agent.v1.ConversationTurnStructure': fields(
      oneof(1, 'agentConversationTurn', 'agent.v1.AgentConversationTurnStructure', 'turn'),
    ),
    'agent.v1.AgentConversationTurnStructure': fields(
      scalar(1, 'userMessage', 12),
      scalar(2, 'steps', 12, { repeated: true }),
    ),
    'agent.v1.ConversationStep': fields(
      oneof(1, 'assistantMessage', 'agent.v1.AssistantMessage', 'message'),
      oneof(2, 'toolCall', 'agent.v1.ToolCall', 'message'),
    ),
    'agent.v1.AssistantMessage': fields(scalar(1, 'text', 9)),
    'agent.v1.ToolCall': fields(
      oneof(15, 'mcpToolCall', 'agent.v1.McpToolCall', 'tool'),
      scalar(57, 'toolCallId', 9),
    ),
    'agent.v1.McpToolCall': fields(
      message(1, 'args', 'agent.v1.McpArgs'),
      message(2, 'result', 'agent.v1.McpToolResult'),
    ),
    'agent.v1.McpToolResult': fields(
      oneof(1, 'success', 'agent.v1.McpSuccess', 'result'),
      oneof(2, 'error', 'agent.v1.McpToolError', 'result'),
    ),
    'agent.v1.McpSuccess': fields(
      message(1, 'content', 'agent.v1.McpToolResultContentItem', { repeated: true }),
    ),
    'agent.v1.McpToolError': fields(scalar(1, 'error', 9)),
    'agent.v1.McpToolResultContentItem': fields(
      oneof(1, 'text', 'agent.v1.McpTextContent', 'content'),
    ),
    'agent.v1.McpTextContent': fields(scalar(1, 'text', 9)),
    'agent.v1.ResumeAction': fields(),
    'agent.v1.ConversationAction': fields(
      oneof(1, 'userMessageAction', 'agent.v1.UserMessageAction', 'action'),
      oneof(2, 'resumeAction', 'agent.v1.ResumeAction', 'action'),
    ),
    'agent.v1.UserMessageAction': fields(message(1, 'userMessage', 'agent.v1.UserMessage')),
    'agent.v1.UserMessage': fields(
      scalar(1, 'text', 9),
      scalar(2, 'messageId', 9),
      scalar(4, 'mode', 13),
    ),
    'agent.v1.RequestedModel': fields(
      scalar(1, 'modelId', 9),
      scalar(2, 'maxMode', 8),
      message(3, 'parameters', 'agent.v1.ModelParameter', { repeated: true }),
      scalar(7, 'builtInModel', 8),
      scalar(8, 'isVariantStringRepresentation', 8),
    ),
    'agent.v1.ModelParameter': fields(scalar(1, 'id', 9), scalar(2, 'value', 9)),
    'agent.v1.ClientHeartbeat': fields(),
    'agent.v1.AgentServerMessage': fields(
      oneof(1, 'interactionUpdate', 'agent.v1.InteractionUpdate'),
      oneof(2, 'execServerMessage', 'agent.v1.ExecServerMessage'),
      oneof(4, 'kvServerMessage', 'agent.v1.KvServerMessage'),
    ),
    'agent.v1.InteractionUpdate': fields(
      oneof(1, 'textDelta', 'agent.v1.TextDeltaUpdate'),
      oneof(2, 'toolCallStarted', 'agent.v1.ToolCallStartedUpdate'),
      oneof(3, 'toolCallCompleted', 'agent.v1.ToolCallCompletedUpdate'),
      oneof(4, 'thinkingDelta', 'agent.v1.ThinkingDeltaUpdate'),
      oneof(7, 'partialToolCall', 'agent.v1.PartialToolCallUpdate'),
      oneof(14, 'turnEnded', 'agent.v1.TurnEndedUpdate'),
    ),
    'agent.v1.TextDeltaUpdate': fields(scalar(1, 'text', 9)),
    'agent.v1.ToolCallStartedUpdate': fields(
      scalar(1, 'callId', 9),
      message(2, 'toolCall', 'agent.v1.ToolCall'),
    ),
    'agent.v1.ToolCallCompletedUpdate': fields(
      scalar(1, 'callId', 9),
      message(2, 'toolCall', 'agent.v1.ToolCall'),
    ),
    'agent.v1.ThinkingDeltaUpdate': fields(scalar(1, 'text', 9)),
    'agent.v1.PartialToolCallUpdate': fields(
      scalar(1, 'callId', 9),
      message(2, 'toolCall', 'agent.v1.ToolCall'),
      scalar(3, 'argsTextDelta', 9),
    ),
    'agent.v1.TurnEndedUpdate': fields(
      scalar(1, 'inputTokens', 4),
      scalar(2, 'outputTokens', 4),
      scalar(3, 'cacheReadTokens', 4),
      scalar(4, 'cacheWriteTokens', 4),
      scalar(5, 'reasoningTokens', 4),
    ),
    'agent.v1.ExecServerMessage': fields(
      scalar(1, 'id', 13),
      scalar(15, 'execId', 9),
      oneof(2, 'shellArgs', 'agent.v1.Empty'),
      oneof(10, 'requestContextArgs', 'agent.v1.Empty'),
      oneof(11, 'mcpArgs', 'agent.v1.McpArgs'),
    ),
    'agent.v1.ExecClientMessage': fields(
      scalar(1, 'id', 13),
      scalar(15, 'execId', 9),
      oneof(2, 'shellResult', 'agent.v1.Empty'),
      oneof(10, 'requestContextResult', 'agent.v1.RequestContextResult'),
    ),
    'agent.v1.RequestContextResult': fields(
      oneof(1, 'success', 'agent.v1.RequestContextSuccess', 'result'),
    ),
    'agent.v1.RequestContextSuccess': fields(
      message(1, 'requestContext', 'agent.v1.RequestContext'),
    ),
    'agent.v1.RequestContext': fields(
      message(7, 'tools', 'agent.v1.McpToolDefinition', { repeated: true }),
      scalar(17, 'webSearchEnabled', 8),
    ),
    'agent.v1.McpToolDefinition': fields(
      scalar(1, 'name', 9),
      scalar(2, 'description', 9),
      message(3, 'inputSchema', 'google.protobuf.Value'),
      scalar(4, 'providerIdentifier', 9),
      scalar(5, 'toolName', 9),
    ),
    'agent.v1.McpArgs': fields(
      scalar(1, 'name', 9),
      {
        no: 2,
        name: 'args',
        localName: 'args',
        kind: 'map',
        repeated: false,
        map: { keyScalar: 9, valueKind: 'message', valueMessage: 'google.protobuf.Value' },
      },
      scalar(3, 'toolCallId', 9),
      scalar(4, 'providerIdentifier', 9),
      scalar(5, 'toolName', 9),
    ),
    'agent.v1.KvServerMessage': fields(
      scalar(1, 'id', 13),
      oneof(2, 'getBlobArgs', 'agent.v1.GetBlobArgs'),
      oneof(3, 'setBlobArgs', 'agent.v1.SetBlobArgs'),
    ),
    'agent.v1.GetBlobArgs': fields(scalar(1, 'blobId', 12)),
    'agent.v1.SetBlobArgs': fields(scalar(1, 'blobId', 12), scalar(2, 'blobData', 12)),
    'agent.v1.KvClientMessage': fields(
      scalar(1, 'id', 13),
      oneof(2, 'getBlobResult', 'agent.v1.GetBlobResult'),
      oneof(3, 'setBlobResult', 'agent.v1.Empty'),
    ),
    'agent.v1.GetBlobResult': fields(scalar(1, 'blobData', 12)),
    'google.protobuf.Value': fields(
      { ...scalar(1, 'nullValue', 13), oneof: 'kind', kind: 'enum' },
      { ...scalar(2, 'numberValue', 1), oneof: 'kind' },
      { ...scalar(3, 'stringValue', 9), oneof: 'kind' },
      { ...scalar(4, 'boolValue', 8), oneof: 'kind' },
      oneof(5, 'structValue', 'google.protobuf.Struct', 'kind'),
      oneof(6, 'listValue', 'google.protobuf.ListValue', 'kind'),
    ),
    'google.protobuf.Struct': fields({
      no: 1,
      name: 'fields',
      localName: 'fields',
      kind: 'map',
      repeated: false,
      map: { keyScalar: 9, valueKind: 'message', valueMessage: 'google.protobuf.Value' },
    }),
    'google.protobuf.ListValue': fields(
      message(1, 'values', 'google.protobuf.Value', { repeated: true }),
    ),
  },
};

function deferred<T = void>() {
  const handlers: Array<{
    readonly resolve: (value: T | PromiseLike<T>) => void;
    readonly reject: (error: unknown) => void;
  }> = [];
  const promise = new Promise<T>((resolve, reject) => handlers.push({ resolve, reject }));
  return {
    promise,
    resolve: (value: T | PromiseLike<T>) => {
      for (const handler of handlers.splice(0)) handler.resolve(value);
    },
    reject: (error: unknown) => {
      for (const handler of handlers.splice(0)) handler.reject(error);
    },
  };
}

const config: BridgeConfig = {
  host: '127.0.0.1',
  port: 9997,
  apiKey: 'bridge-key',
  backend: 'cursor-api',
  defaultModel: 'composer-2.5',
  workspaceMode: 'chat-only',
  version: '0.1.0',
};

class FakeRunStream extends EventEmitter implements CursorRunStream {
  destroyed = false;
  writableEnded = false;
  readonly writes: Buffer[] = [];
  readonly firstWrite = deferred();
  constructor(private readonly onFirstWrite: (stream: FakeRunStream) => void) {
    super();
  }
  write(chunk: Uint8Array): boolean {
    this.writes.push(Buffer.from(chunk));
    if (this.writes.length === 1) {
      this.firstWrite.resolve();
      queueMicrotask(() => this.onFirstWrite(this));
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
    if (error) this.emit('error', error);
    this.emit('close');
  }
  close(): void {
    this.end();
  }
}

class FakeTransport implements CursorApiTransport {
  readonly codec = new ProtoCodec(descriptors);
  readonly streamOpened = deferred<FakeRunStream>();
  openRunCount = 0;
  dataChunkCount = 0;
  stream?: FakeRunStream;
  constructor(private readonly script: Array<Record<string, unknown>> | 'manual' | 'stall') {}
  async unary(path: string): Promise<Buffer> {
    if (path.includes('GetServerConfig')) {
      return this.codec.encode('aiserver.v1.GetServerConfigResponse', {
        agentUrlConfig: { agentnUrl: 'https://agent.test' },
      });
    }
    return Buffer.alloc(0);
  }
  async openRun(): Promise<CursorRunStream> {
    this.openRunCount += 1;
    this.stream = new FakeRunStream((stream) => {
      stream.emit('response', { ':status': 200 });
      if (this.script === 'manual' || this.script === 'stall') return;
      const frames = this.script.map((messageValue) =>
        encodeConnectFrame(this.codec.encode('agent.v1.AgentServerMessage', messageValue)),
      );
      frames.push(encodeConnectFrame(Buffer.from('{}'), { trailer: true }));
      this.dataChunkCount += 1;
      stream.emit('data', Buffer.concat(frames));
    });
    this.streamOpened.resolve(this.stream);
    return this.stream;
  }
}

const serverMessage = (caseName: string, value: Record<string, unknown>) => ({
  message: { case: caseName, value },
});
const update = (caseName: string, value: Record<string, unknown>) =>
  serverMessage('interactionUpdate', { message: { case: caseName, value } });

function testRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('expected test object');
  }
  return Object.fromEntries(Object.entries(value));
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new TypeError(`missing test ${label}`);
  return value;
}

function rootPromptEntries(history: CursorHistory): Array<Record<string, unknown>> {
  return history.conversationState.rootPromptMessagesJson.map((id) =>
    testRecord(
      JSON.parse(
        required(history.blobs.get(id.toString('hex')), 'root prompt blob').toString('utf8'),
      ),
    ),
  );
}

function backendWith(transport: FakeTransport) {
  return new CursorApiBackend(config, {
    loadNativeContext: fixtureNativeContext,
    descriptors,
    transport,
    auth: new CursorAuthProvider({ environment: { CURSOR_AUTH_TOKEN: 'token' } }),
    wait: async () => undefined,
  });
}

function jwt(exp: number): string {
  return `x.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.y`;
}

describe('Cursor API Connect framing', () => {
  it('rejects frames with unsupported flag bits', () => {
    const decoder = new ConnectFrameDecoder();
    const frame = encodeConnectFrame(Buffer.from('payload'));
    frame[0] = 0x04;

    expect(() => decoder.push(frame)).toThrow('unsupported flag bits');
  });

  it('rejects compressed frames whose decoded payload exceeds the configured bound', () => {
    const decoder = new ConnectFrameDecoder(64);
    const compressed = encodeConnectFrame(Buffer.alloc(1_024, 0x61), { compressed: true });

    expect(() => decoder.push(compressed)).toThrow('decoded payload exceeds 64 bytes');
  });

  it('rejects cumulative decoded payloads within one compressed chunk', () => {
    const decoder = new ConnectFrameDecoder(64);
    const compressed = Buffer.concat([
      encodeConnectFrame(Buffer.alloc(40, 0x61), { compressed: true }),
      encodeConnectFrame(Buffer.alloc(40, 0x62), { compressed: true }),
    ]);

    expect(() => decoder.push(compressed)).toThrow('decoded payload exceeds 64 bytes');
  });

  it('round-trips split plain and gzip frames and maps trailer errors', () => {
    const decoder = new ConnectFrameDecoder();
    const plain = encodeConnectFrame(Buffer.from('plain'));
    const gzip = encodeConnectFrame(Buffer.from('compressed'), { compressed: true });
    expect(decoder.push(plain.subarray(0, 3))).toEqual([]);
    const frames = decoder.push(Buffer.concat([plain.subarray(3), gzip]));
    expect(frames.map((frame) => frame.payload?.toString())).toEqual(['plain', 'compressed']);
    decoder.finish();

    const failed = new ConnectFrameDecoder();
    expect(() =>
      failed.push(
        encodeConnectFrame(
          Buffer.from(JSON.stringify({ error: { code: 'resource_exhausted', message: 'quota' } })),
          { trailer: true },
        ),
      ),
    ).toThrowError(ConnectRpcError);
    expect(() => failed.finish()).not.toThrow();

    for (const invalid of ['[]', 'null']) {
      const malformed = new ConnectFrameDecoder();
      expect(() =>
        malformed.push(
          encodeConnectFrame(Buffer.from(invalid), {
            trailer: true,
          }),
        ),
      ).toThrowError(ConnectRpcError);
      expect(() => malformed.finish()).not.toThrow();
    }

    const nullError = new ConnectFrameDecoder();
    expect(() =>
      nullError.push(
        encodeConnectFrame(Buffer.from('{"error":null}'), {
          trailer: true,
        }),
      ),
    ).toThrowError(ConnectRpcError);

    const structured = new ConnectFrameDecoder();
    let structuredError: unknown;
    try {
      structured.push(
        encodeConnectFrame(
          Buffer.from(
            JSON.stringify({
              error: {
                code: 'resource_exhausted',
                message: 'quota',
                details: [{ value: { errorType: 'PRO_USER_RATE_LIMIT_EXCEEDED' } }],
              },
            }),
          ),
          { trailer: true },
        ),
      );
    } catch (error) {
      structuredError = error;
    }
    expect(structuredError).toMatchObject({
      code: 'resource_exhausted',
      details: [{ value: { errorType: 'PRO_USER_RATE_LIMIT_EXCEEDED' } }],
    });
    expect(isRetryableCursorTransportError(structuredError)).toBe(false);
  });
});

describe('Cursor API authentication and descriptors', () => {
  it('reads and caches a valid Keychain JWT', async () => {
    let reads = 0;
    const auth = new CursorAuthProvider({
      environment: {},
      now: () => 1_000_000,
      keychain: async () => {
        reads += 1;
        return jwt(2_000);
      },
    });
    expect(await auth.getToken()).toBe(jwt(2_000));
    expect(await auth.getToken()).toBe(jwt(2_000));
    expect(reads).toBe(1);
  });

  it('refreshes an expiring direct JWT through API-key exchange', async () => {
    const fresh = jwt(9_999);
    let exchanges = 0;
    const auth = new CursorAuthProvider({
      environment: { CURSOR_AUTH_TOKEN: jwt(1_100), CURSOR_API_KEY: 'api-key' },
      now: () => 1_000_000,
      fetch: async (_input, init) => {
        exchanges += 1;
        expect(init?.body).toBe('{}');
        const headers = new Headers(init?.headers);
        expect(headers.get('authorization')).toBe('Bearer api-key');
        return new Response(JSON.stringify({ accessToken: fresh }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    expect(await auth.getToken()).toBe(fresh);
    expect(await auth.getToken()).toBe(fresh);
    expect(exchanges).toBe(1);
  });

  it('stops waiting for a shared token refresh when the caller aborts', async () => {
    const exchangeStarted = deferred();
    const exchange = deferred<Response>();
    const fresh = jwt(9_999);
    const auth = new CursorAuthProvider({
      environment: { CURSOR_API_KEY: 'api-key' },
      fetch: async () => {
        exchangeStarted.resolve();
        return exchange.promise;
      },
    });
    const controller = new AbortController();
    const token = auth.getToken(undefined, controller.signal);
    await exchangeStarted.promise;

    controller.abort();
    const deadline = AbortSignal.timeout(100);
    const outcome = await Promise.race([
      token.then(
        () => 'resolved',
        (error: unknown) => (error instanceof Error ? error.name : 'rejected'),
      ),
      new Promise<string>((resolve) => {
        deadline.addEventListener('abort', () => resolve('pending'), { once: true });
      }),
    ]);
    exchange.resolve(
      new Response(JSON.stringify({ accessToken: fresh }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    expect(outcome).toBe('AbortError');
    await expect(auth.getToken()).resolves.toBe(fresh);
  });

  it('reports an actionable descriptor loading failure', () => {
    expect(() => loadProtoDescriptors('/definitely/missing/descriptors.json')).toThrow(
      'npm run extract-protos',
    );
    expect(() => loadProtoDescriptors('/definitely/missing/descriptors.json')).toThrow(
      'CURSOR_BRIDGE_CURSOR_API_DESCRIPTORS',
    );
  });

  it('rejects descriptors missing native tool announcement fields', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cursor-api-old-descriptors-'));
    const descriptorPath = join(dir, 'proto-descriptors.json');
    const outdated = structuredClone(descriptors);
    const interactionUpdate = required(
      outdated.messages['agent.v1.InteractionUpdate'],
      'interaction update descriptor',
    );
    interactionUpdate.fields = interactionUpdate.fields.filter(
      (field) => !['partialToolCall', 'toolCallStarted'].includes(field.localName),
    );
    writeFileSync(descriptorPath, JSON.stringify(outdated));
    expect(() => loadProtoDescriptors(descriptorPath)).toThrow(/outdated.*extract-protos/i);
  });

  it('loads descriptors from CURSOR_BRIDGE_CURSOR_API_DESCRIPTORS on headless-only hosts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cursor-api-descriptors-'));
    const descriptorPath = join(dir, 'proto-descriptors.json');
    writeFileSync(descriptorPath, JSON.stringify(descriptors));
    const backend = new CursorApiBackend(config, {
      environment: { CURSOR_BRIDGE_CURSOR_API_DESCRIPTORS: descriptorPath },
      transport: new FakeTransport([]),
      auth: new CursorAuthProvider({ environment: { CURSOR_AUTH_TOKEN: 'token' } }),
    });
    expect(backend).toBeInstanceOf(CursorApiBackend);
  });
});

describe('Cursor API startup and wire parity', () => {
  it('uses the captured CLI header-name sets for unary and Run', async () => {
    const unaryHeaderSets: Record<string, string>[] = [];
    let runHeaders: OutgoingHttpHeaders = {};
    const session = Object.assign(new EventEmitter(), {
      closed: false,
      destroyed: false,
      close() {
        this.closed = true;
      },
      request(headers: OutgoingHttpHeaders) {
        runHeaders = headers;
        return new FakeRunStream(() => undefined);
      },
    });
    const transport = new NodeCursorApiTransport({
      auth: new CursorAuthProvider({ environment: { CURSOR_AUTH_TOKEN: 'token' } }),
      clientVersion: 'cli-2026.08.11-e8db854',
      fetch: async (_input, init) => {
        unaryHeaderSets.push(Object.fromEntries(new Headers(init?.headers)));
        return new Response(Buffer.alloc(0), { status: 200 });
      },
      connect: () => session,
    });
    await transport.unary('/bootstrap', Buffer.alloc(0), undefined, true);
    await transport.unary('/test', Buffer.alloc(0));
    const stream = await transport.openRun('https://agent.test', 'request-id');
    expect(Object.keys(unaryHeaderSets[0] ?? {}).sort()).toEqual(
      [...CURSOR_BOOTSTRAP_UNARY_HEADER_NAMES].sort(),
    );
    expect(Object.keys(unaryHeaderSets[1] ?? {}).sort()).toEqual(
      [...CURSOR_UNARY_HEADER_NAMES].sort(),
    );
    expect(
      Object.keys(runHeaders)
        .filter((name) => !name.startsWith(':'))
        .sort(),
    ).toEqual([...CURSOR_RUN_HEADER_NAMES].sort());
    expect(runHeaders['x-blob-encryption-key']).toMatch(/^[0-9a-f]{64}$/);
    stream.close();
  });

  it('closes the HTTP/2 session when opening a Run throws synchronously', async () => {
    const close = vi.fn();
    const failure = Object.assign(new Error('session unavailable'), {
      code: 'ERR_HTTP2_GOAWAY_SESSION',
    });
    const session = Object.assign(new EventEmitter(), {
      closed: false,
      destroyed: false,
      close,
      request() {
        throw failure;
      },
    });
    const transport = new NodeCursorApiTransport({
      auth: new CursorAuthProvider({ environment: { CURSOR_AUTH_TOKEN: 'token' } }),
      clientVersion: 'cli-2026.08.11-e8db854',
      connect: () => session,
    });

    await expect(transport.openRun('https://agent.test', 'request-id')).rejects.toBe(failure);
    expect(close).toHaveBeenCalledOnce();
  });

  it('performs the captured AI startup sequence and minimal telemetry flushes', async () => {
    const paths: string[] = [];
    const fake = new FakeTransport([]);
    const transport: CursorApiTransport = {
      ...fake,
      unary: async (path) => {
        paths.push(path);
        return fake.unary(path);
      },
      telemetry: async (path) => {
        paths.push(path);
      },
      openRun: () => fake.openRun(),
    };
    await new CursorApiBackend(config, {
      descriptors,
      transport,
      auth: new CursorAuthProvider({ environment: { CURSOR_AUTH_TOKEN: 'token' } }),
    }).initialize();
    expect(paths).toEqual(CURSOR_API_STARTUP_SEQUENCE);
  });

  it('maps a non-composer legacy slug to the base model and captured parameters', () => {
    const liveCodec = new ProtoCodec(loadProtoDescriptors());
    const requestedModels = mapRequestedModels(
      {
        models: [
          {
            name: 'grok-4.6',
            variants: [
              {
                legacySlug: 'cursor-grok-4.6-high',
                parameterValues: [
                  { id: 'effort', value: 'high' },
                  { id: 'fast', value: 'false' },
                ],
                isMaxMode: false,
              },
            ],
          },
        ],
      },
      { models: [{ modelId: 'cursor-grok-4.6-high', maxMode: false }] },
    );
    const decodedRun = objectAt(
      liveCodec.decode(
        'agent.v1.AgentClientMessage',
        liveCodec.encode(
          'agent.v1.AgentClientMessage',
          runRequestMessage(
            { model: 'cursor-grok-4.6-high', messages: [{ role: 'user', content: 'hello' }] },
            'request-id',
            requestedModels,
            undefined,
            undefined,
            [{ modelId: 'grok-4.6', parameters: [{ id: 'effort', value: 'low' }] }],
          ),
        ),
      ),
      ['message', 'value'],
    );

    expect(decodedRun.requestedModel).toMatchObject({
      modelId: 'grok-4.6',
      parameters: [
        { id: 'effort', value: 'high' },
        { id: 'fast', value: 'false' },
      ],
    });
    expect(
      arrayAt(decodedRun.selectedSubagentModels).find(
        (model) => objectAt(model).modelId === 'grok-4.6',
      ),
    ).toMatchObject(objectAt(decodedRun.requestedModel));
  });

  it('preserves Run and context fields with server-provided subagent models', () => {
    const liveCodec = new ProtoCodec(loadProtoDescriptors());
    const decodedRun = objectAt(
      liveCodec.decode(
        'agent.v1.AgentClientMessage',
        liveCodec.encode(
          'agent.v1.AgentClientMessage',
          runRequestMessage(
            { model: 'composer-2.5', messages: [{ role: 'user', content: 'hello' }] },
            'request-id',
            undefined,
            undefined,
            undefined,
            [
              { modelId: 'composer-2.5', parameters: [] },
              { modelId: 'new-server-model', parameters: [{ id: 'effort', value: 'high' }] },
            ],
          ),
        ),
      ),
      ['message', 'value'],
    );
    expect(Object.keys(decodedRun).sort()).toEqual(
      [
        'action',
        'conversationGroupId',
        'conversationId',
        'conversationState',
        'excludeWorkspaceContext',
        'mcpTools',
        'requestedModel',
        'runId',
        'selectedSubagentModels',
      ].sort(),
    );
    expect(decodedRun.selectedSubagentModels).toEqual([
      { modelId: 'composer-2.5', parameters: [{ id: 'fast', value: 'false' }] },
      { modelId: 'new-server-model', parameters: [{ id: 'effort', value: 'high' }] },
    ]);

    const context = objectAt(
      liveCodec.decode(
        'agent.v1.RequestContextResult',
        liveCodec.encode(
          'agent.v1.RequestContextResult',
          requestContextResult(
            { model: 'composer-2.5', messages: [{ role: 'user', content: 'hello' }] },
            '/tmp/work',
            { SHELL: '/bin/zsh' },
          ),
        ),
      ),
      ['result', 'value', 'requestContext'],
    );
    expect(context.env).toMatchObject({
      workspacePaths: ['/tmp/work'],
      shell: 'zsh',
      processWorkingDirectory: '/tmp/work',
    });
    expect(context.supportsMcpAuth).toBe(true);
    expect(context.gitRepoInfoComplete).toBe(true);
  });

  it('uses the native CLI default agent mode independently of external tool availability', () => {
    const baseRequest = {
      model: 'composer-2.5',
      messages: [{ role: 'user' as const, content: 'hello' }],
    };
    const echoTool = {
      type: 'function' as const,
      function: {
        name: 'echo_value',
        parameters: { type: 'object' },
      },
    };
    const withoutTools = runRequestMessage(baseRequest, 'request-without-tools');
    const withTools = runRequestMessage(
      {
        ...baseRequest,
        tools: [echoTool],
      },
      'request-with-tools',
    );
    const suppressed = runRequestMessage(
      {
        ...baseRequest,
        tools: [echoTool],
        tool_choice: 'none' as const,
      },
      'request-tools-none',
    );

    expect(withoutTools).toMatchObject({
      message: {
        value: {
          action: {
            action: { value: { userMessage: { mode: 1 } } },
          },
        },
      },
    });
    expect(withTools).toMatchObject({
      message: {
        value: {
          action: {
            action: { value: { userMessage: { mode: 1 } } },
          },
        },
      },
    });
    expect(suppressed).toMatchObject({
      message: {
        value: {
          action: {
            action: { value: { userMessage: { mode: 1 } } },
          },
        },
      },
    });
  });

  it('does not forbid another tool call after a tool result in auto mode', () => {
    const liveCodec = new ProtoCodec(loadProtoDescriptors());
    const messages: ChatCompletionRequest['messages'] = [
      { role: 'user', content: 'start' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_seed',
            type: 'function',
            function: { name: 'get_seed', arguments: '{"label":"alpha"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_seed', content: 'alpha=7' },
    ];
    const tools = [
      {
        type: 'function' as const,
        function: { name: 'multiply', parameters: { type: 'object' } },
      },
    ];
    const roots = (choice: ChatCompletionRequest['tool_choice']) => {
      const history = buildCursorHistory(
        { model: 'composer-2.5', messages, tools, tool_choice: choice },
        liveCodec,
      );
      return rootPromptEntries(history);
    };

    expect(roots('auto').map((entry) => entry.role)).toEqual(['user', 'assistant', 'tool']);
    expect(roots('none').map((entry) => entry.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'system',
    ]);
  });
  it('maps the baseline two-round history into structured conversation state', () => {
    const liveCodec = new ProtoCodec(loadProtoDescriptors());
    const decodedRun = objectAt(
      liveCodec.decode(
        'agent.v1.AgentClientMessage',
        liveCodec.encode(
          'agent.v1.AgentClientMessage',
          runRequestMessage(
            {
              model: 'composer-2.5',
              messages: [
                { role: 'user', content: 'look up the seed' },
                {
                  role: 'assistant',
                  content: '',
                  tool_calls: [
                    {
                      id: 'call_seed',
                      type: 'function',
                      function: { name: 'lookup_code', arguments: '{"file":"seed.ts"}' },
                    },
                  ],
                },
                { role: 'tool', tool_call_id: 'call_seed', content: 'seed=20260818' },
              ],
              tools: [
                {
                  type: 'function',
                  function: { name: 'lookup_code', parameters: { type: 'object' } },
                },
              ],
            },
            'request-id',
          ),
        ),
      ),
      ['message', 'value'],
    );

    expect(valueAt(decodedRun, ['action', 'action', 'case'])).toBe('resumeAction');
    expect(
      arrayAt(decodedRun, ['conversationState', 'rootPromptMessagesJson']).length,
    ).toBeGreaterThanOrEqual(3);
    expect(arrayAt(decodedRun, ['conversationState', 'turns']).length).toBe(1);
  });

  it('rejects orphan and duplicate tool results before opening an upstream Run', async () => {
    const orphanTransport = new FakeTransport('manual');
    const orphanSpy = vi.spyOn(orphanTransport, 'openRun');
    await expect(
      backendWith(orphanTransport).complete({
        model: 'composer-2.5',
        messages: [
          { role: 'user', content: 'start' },
          { role: 'tool', tool_call_id: 'ghost', content: 'orphan result' },
        ],
      }),
    ).rejects.toThrow(ToolHistoryValidationError);
    expect(orphanSpy).not.toHaveBeenCalled();

    const duplicateTransport = new FakeTransport('manual');
    const duplicateSpy = vi.spyOn(duplicateTransport, 'openRun');
    await expect(
      backendWith(duplicateTransport).complete({
        model: 'composer-2.5',
        messages: [
          { role: 'user', content: 'start' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_dup',
                type: 'function',
                function: { name: 'echo_value', arguments: '{}' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call_dup', content: 'first' },
          { role: 'tool', tool_call_id: 'call_dup', content: 'second' },
        ],
      }),
    ).rejects.toThrow(ToolHistoryValidationError);
    expect(duplicateSpy).not.toHaveBeenCalled();
  }, 20_000);
});

describe('Cursor API mapping and Run lifecycle', () => {
  it('waits for every announced native tool call before completing a batch', () => {
    const calls = [
      {
        id: 'call-one',
        type: 'function' as const,
        function: { name: 'echo_value', arguments: '{"value":"one"}' },
      },
      {
        id: 'call-two',
        type: 'function' as const,
        function: { name: 'echo_value', arguments: '{"value":"two"}' },
      },
    ];

    const announced = new Set(['call-one', 'call-two']);
    expect(nativeToolBatchComplete(announced, calls.slice(0, 1), true)).toBe(false);
    expect(nativeToolBatchComplete(announced, calls, true)).toBe(true);
    expect(nativeToolBatchComplete(announced, calls.slice(0, 1), false)).toBe(true);
  });

  it('maps usable models and completes scripted text while answering exec and KV messages', async () => {
    expect(
      mapUsableModels({ models: [{ modelId: 'composer-2.5', aliases: ['composer'] }] }).map(
        (model) => model.id,
      ),
    ).toEqual(['composer-2.5', 'composer']);

    const transport = new FakeTransport([
      serverMessage('execServerMessage', {
        id: 1,
        execId: 'context',
        message: { case: 'requestContextArgs', value: {} },
      }),
      serverMessage('execServerMessage', {
        id: 2,
        execId: 'shell',
        message: { case: 'shellArgs', value: {} },
      }),
      serverMessage('kvServerMessage', {
        id: 3,
        message: {
          case: 'setBlobArgs',
          value: { blobId: Buffer.from('id'), blobData: Buffer.from('data') },
        },
      }),
      update('textDelta', { text: 'DIRECT_OK' }),
      update('turnEnded', { inputTokens: 12, outputTokens: 3 }),
    ]);
    const result = await backendWith(transport).complete({
      model: 'composer-2.5',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(result.content).toBe('DIRECT_OK');
    expect(result.usage).toEqual({ prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 });

    const decoder = new ConnectFrameDecoder();
    const outbound = required(transport.stream, 'run stream').writes.flatMap((write) =>
      decoder
        .push(write)
        .map((frame) =>
          transport.codec.decode(
            'agent.v1.AgentClientMessage',
            required(frame.payload, 'outbound frame payload'),
          ),
        ),
    );
    expect(outbound.map((item) => objectAt(item.message).case)).toEqual(
      expect.arrayContaining([
        'runRequest',
        'execClientMessage',
        'execClientControlMessage',
        'kvClientMessage',
      ]),
    );
    const execCases = outbound
      .filter((item) => objectAt(item.message).case === 'execClientMessage')
      .map((item) => valueAt(item, ['message', 'value', 'message', 'case']));
    expect(execCases).toEqual(['requestContextResult', 'shellResult']);
    expect(
      outbound
        .filter((item) => objectAt(item.message).case === 'execClientControlMessage')
        .map((item) => valueAt(item, ['message', 'value', 'message', 'value', 'id'])),
    ).toEqual([1, 2]);
  });

  it('streams text deltas and returns native MCP invocations as OpenAI tool calls', async () => {
    const streamTransport = new FakeTransport([
      update('textDelta', { text: 'one ' }),
      update('textDelta', { text: 'two' }),
      update('turnEnded', { inputTokens: 4, outputTokens: 2 }),
    ]);
    const events = [];
    for await (const event of backendWith(streamTransport).completeStream({
      model: 'composer-2.5',
      messages: [{ role: 'user', content: 'stream' }],
    }))
      events.push(event);
    expect(events).toEqual([
      { type: 'content', text: 'one ' },
      { type: 'content', text: 'two' },
      {
        type: 'done',
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
        usage_source: 'turnEnded',
        is_error: false,
      },
    ]);

    const toolRequest = {
      model: 'composer-2.5',
      messages: [{ role: 'user' as const, content: 'call echo' }],
      tools: [
        {
          type: 'function' as const,
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
      tool_choice: 'required' as const,
    };
    const wireName = mapCursorApiToolRequest(toolRequest).request.tools?.[0]?.function.name;
    if (!wireName) throw new Error('wire tool name was not created');
    const toolTransport = new FakeTransport([
      serverMessage('execServerMessage', {
        id: 1,
        execId: 'context',
        message: { case: 'requestContextArgs', value: {} },
      }),
      update('partialToolCall', { callId: 'call_native_1' }),
      serverMessage('execServerMessage', {
        id: 2,
        execId: 'tool',
        message: {
          case: 'mcpArgs',
          value: {
            name: wireName,
            toolName: wireName,
            providerIdentifier: 'bridge',
            toolCallId: 'call_native_1',
            args: { value: jsonToProtoValue('NATIVE_OK') },
          },
        },
      }),
    ]);
    const result = await backendWith(toolTransport).complete(toolRequest);
    expect(result.tool_calls).toEqual([
      {
        id: expect.stringMatching(/^call_[a-f0-9]{32}_0$/),
        type: 'function',
        function: { name: 'echo_value', arguments: '{"value":"NATIVE_OK"}' },
      },
    ]);
    expect(toolTransport.stream?.writableEnded || toolTransport.stream?.destroyed).toBe(true);
  });

  it('emits stable typed tool events from native start, split args, and completion frames', async () => {
    const request = {
      model: 'composer-2.5',
      messages: [{ role: 'user' as const, content: 'call both tools' }],
      tools: [
        {
          type: 'function' as const,
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
      tool_choice: 'auto' as const,
      parallel_tool_calls: true,
    };
    const wireName = mapCursorApiToolRequest(request).request.tools?.[0]?.function.name;
    if (!wireName) throw new Error('wire tool name was not created');
    const toolCall = (id: string, value: string) => ({
      tool: {
        case: 'mcpToolCall',
        value: {
          args: {
            name: wireName,
            toolName: wireName,
            providerIdentifier: 'bridge',
            toolCallId: id,
            args: { value: jsonToProtoValue(value) },
          },
        },
      },
      toolCallId: id,
    });
    const script = [
      update('toolCallStarted', { callId: 'envelope_a', toolCall: toolCall('call_a', '') }),
      update('toolCallStarted', { callId: 'envelope_b', toolCall: toolCall('call_b', '') }),
      update('partialToolCall', { callId: 'envelope_a', argsTextDelta: '{"value":' }),
      update('partialToolCall', { callId: 'envelope_b', argsTextDelta: '{"value":"B"}' }),
      update('partialToolCall', { callId: 'envelope_a', argsTextDelta: '{"value":"A"}' }),
      serverMessage('execServerMessage', {
        id: 2,
        execId: 'tool_b',
        message: {
          case: 'mcpArgs',
          value: {
            name: wireName,
            toolName: wireName,
            providerIdentifier: 'bridge',
            toolCallId: 'call_b',
            args: { value: jsonToProtoValue('B') },
          },
        },
      }),
      update('toolCallCompleted', {
        callId: 'envelope_b',
        toolCall: toolCall('call_b', 'B'),
      }),
      update('turnEnded', { inputTokens: 8, outputTokens: 4 }),
      update('toolCallCompleted', {
        callId: 'envelope_a',
        toolCall: toolCall('call_a', 'A'),
      }),
    ];
    const transport = new FakeTransport(script);

    const events = [];
    for await (const event of backendWith(transport).completeStream(request)) events.push(event);
    const starts = events.filter((event) => event.type === 'tool_call_start');
    const idA = starts[0]?.id;
    const idB = starts[1]?.id;
    expect(idA).toMatch(/^call_[a-f0-9]{32}_0$/);
    expect(idB).toMatch(/^call_[a-f0-9]{32}_1$/);
    expect(idA).not.toBe(idB);

    expect(events).toEqual([
      { type: 'tool_call_start', index: 0, id: idA, name: 'echo_value' },
      { type: 'tool_call_start', index: 1, id: idB, name: 'echo_value' },
      { type: 'tool_call_arguments_delta', index: 0, id: idA, delta: '{"value":' },
      {
        type: 'tool_call_arguments_delta',
        index: 1,
        id: idB,
        delta: '{"value":"B"}',
      },
      { type: 'tool_call_arguments_delta', index: 0, id: idA, delta: '"A"}' },
      {
        type: 'tool_call_complete',
        index: 0,
        call: {
          id: idA,
          type: 'function',
          function: { name: 'echo_value', arguments: '{"value":"A"}' },
        },
      },
      {
        type: 'tool_call_complete',
        index: 1,
        call: {
          id: idB,
          type: 'function',
          function: { name: 'echo_value', arguments: '{"value":"B"}' },
        },
      },
      {
        type: 'done',
        usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
        usage_source: 'turnEnded',
        is_error: false,
      },
    ]);
    const nonStream = await backendWith(new FakeTransport(script)).complete(request);
    expect(
      events
        .filter((event) => event.type === 'tool_call_complete')
        .map((event) => event.call.function),
    ).toEqual(nonStream.tool_calls?.map((call) => call.function));
  });

  it('drains one decoded chunk before settling a staggered parallel tool batch over HTTP SSE', async () => {
    const request = {
      model: 'composer-2.5',
      messages: [{ role: 'user' as const, content: 'call both tools in parallel' }],
      tools: [
        {
          type: 'function' as const,
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
      tool_choice: 'auto' as const,
      parallel_tool_calls: true,
    };
    const wireName = mapCursorApiToolRequest(request).request.tools?.[0]?.function.name;
    if (!wireName) throw new Error('wire tool name was not created');
    const valueA = 'BENCH_TOOL_PARALLEL_TWO_YORHA_AC3818DC1E57';
    const valueB = `${valueA}_SECOND`;
    const argsA = JSON.stringify({ value: valueA });
    const argsB = JSON.stringify({ value: valueB });
    expect(Buffer.byteLength(argsA)).toBe(54);
    expect(Buffer.byteLength(argsB)).toBe(61);
    const toolCall = (id: string, value: string) => ({
      tool: {
        case: 'mcpToolCall',
        value: {
          args: {
            name: wireName,
            toolName: wireName,
            providerIdentifier: 'bridge',
            toolCallId: id,
            args: { value: jsonToProtoValue(value) },
          },
        },
      },
      toolCallId: id,
    });
    const transport = new FakeTransport([
      update('toolCallStarted', {
        callId: 'envelope_a',
        toolCall: toolCall('call_a_start', ''),
      }),
      update('partialToolCall', { callId: 'envelope_a', argsTextDelta: argsA }),
      serverMessage('execServerMessage', {
        id: 2,
        execId: 'tool_a',
        message: {
          case: 'mcpArgs',
          value: {
            name: wireName,
            toolName: wireName,
            providerIdentifier: 'bridge',
            toolCallId: 'call_a_final',
            args: { value: jsonToProtoValue(valueA) },
          },
        },
      }),
      update('toolCallStarted', {
        callId: 'envelope_b',
        toolCall: toolCall('call_b_start', ''),
      }),
      update('partialToolCall', { callId: 'envelope_b', argsTextDelta: argsB }),
      update('toolCallCompleted', {
        callId: 'envelope_b',
        toolCall: toolCall('call_b_final', valueB),
      }),
      update('turnEnded', { inputTokens: 8, outputTokens: 4 }),
    ]);
    const cursor = backendWith(transport);
    const typedEvents: CompletionStreamEvent[] = [];
    const observed: CursorBackend = {
      type: cursor.type,
      health: () => cursor.health(),
      listModels: () => cursor.listModels(),
      complete: (candidate, signal) => cursor.complete(candidate, signal),
      completeStream: async function* (candidate, signal) {
        for await (const event of cursor.completeStream(candidate, signal)) {
          typedEvents.push(event);
          yield event;
        }
      },
      shutdown: () => cursor.shutdown(),
    };
    const server = await buildServer({
      config: { ...config, host: '127.0.0.1', port: 0, clientAuth: 'off' },
      backend: observed,
    });
    let body = '';
    let status: number | undefined;
    try {
      await server.listen({ host: '127.0.0.1', port: 0 });
      const address = server.server.address();
      if (!address || typeof address === 'string') throw new Error('server address is not TCP');
      const port = address.port;
      const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
        const outgoing = httpRequest(
          {
            host: '127.0.0.1',
            port,
            path: '/v1/chat/completions',
            method: 'POST',
            headers: { 'content-type': 'application/json' },
          },
          resolve,
        );
        outgoing.once('error', reject);
        outgoing.end(
          JSON.stringify({ ...request, stream: true, stream_options: { include_usage: true } }),
        );
      });
      status = response.statusCode;
      for await (const chunk of response) body += chunk;
    } finally {
      await server.close();
    }
    const frames = body
      .split('\n\n')
      .filter((frame) => frame.startsWith('data: {'))
      .map((frame) => JSON.parse(frame.slice(6)));
    const calls = new Map<number, ToolCall>();
    for (const frame of frames) {
      for (const item of frame.choices?.[0]?.delta?.tool_calls ?? []) {
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

    expect(status).toBe(200);
    expect(transport.openRunCount).toBe(1);
    expect(transport.dataChunkCount).toBe(1);
    const typedStarts = typedEvents.filter((event) => event.type === 'tool_call_start');
    const idA = typedStarts[0]?.id;
    const idB = typedStarts[1]?.id;
    expect(idA).toMatch(/^call_[a-f0-9]{32}_0$/);
    expect(idB).toMatch(/^call_[a-f0-9]{32}_1$/);
    expect(typedStarts).toEqual([
      { type: 'tool_call_start', index: 0, id: idA, name: 'echo_value' },
      { type: 'tool_call_start', index: 1, id: idB, name: 'echo_value' },
    ]);
    expect([...calls.values()]).toEqual([
      {
        id: idA,
        type: 'function',
        function: { name: 'echo_value', arguments: argsA },
      },
      {
        id: idB,
        type: 'function',
        function: { name: 'echo_value', arguments: argsB },
      },
    ]);
    expect(
      typedEvents
        .filter((event) => event.type === 'tool_call_complete')
        .map((event) => ({ index: event.index, id: event.call.id })),
    ).toEqual([
      { index: 0, id: idA },
      { index: 1, id: idB },
    ]);
    expect(body.match(/"finish_reason":"tool_calls"/g)).toHaveLength(1);
    expect(frames.find((frame) => frame.choices?.length === 0)?.usage).toEqual({
      prompt_tokens: 8,
      completion_tokens: 4,
      total_tokens: 12,
    });
    expect(body.trim().endsWith('data: [DONE]')).toBe(true);
    expect(body).not.toContain('[TOOL_CALLS:');
    expect(body).not.toContain('backend_error');
  });

  it('rejects invalid incremental completion without a successful complete event', async () => {
    const request = {
      model: 'composer-2.5',
      messages: [{ role: 'user' as const, content: 'call echo' }],
      tools: [
        {
          type: 'function' as const,
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
      tool_choice: 'auto' as const,
    };
    const wireName = mapCursorApiToolRequest(request).request.tools?.[0]?.function.name;
    if (!wireName) throw new Error('wire tool name was not created');
    const invalidCall = {
      tool: {
        case: 'mcpToolCall',
        value: {
          args: {
            name: wireName,
            toolName: wireName,
            providerIdentifier: 'bridge',
            toolCallId: 'call_invalid',
            args: {},
          },
        },
      },
      toolCallId: 'call_invalid',
    };
    const transport = new FakeTransport([
      update('toolCallStarted', { callId: 'invalid_envelope', toolCall: invalidCall }),
      update('partialToolCall', { callId: 'invalid_envelope', argsTextDelta: '{}' }),
      update('toolCallCompleted', { callId: 'invalid_envelope', toolCall: invalidCall }),
    ]);
    const events: CompletionStreamEvent[] = [];

    await expect(
      (async () => {
        for await (const event of backendWith(transport).completeStream(request)) {
          events.push(event);
        }
      })(),
    ).rejects.toThrow('required property');
    expect(events.some((event) => event.type === 'tool_call_complete')).toBe(false);
  });

  it('retries one buffered invalid completion once, then returns a validation error', async () => {
    const request = {
      model: 'composer-2.5',
      messages: [{ role: 'user' as const, content: 'required echo' }],
      tools: [
        {
          type: 'function' as const,
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
      tool_choice: 'required' as const,
    };
    const wireName = mapCursorApiToolRequest(request).request.tools?.[0]?.function.name;
    if (!wireName) throw new Error('wire tool name was not created');
    const invalidArgs = {
      name: wireName,
      toolName: wireName,
      providerIdentifier: 'bridge',
      toolCallId: 'call_invalid',
      args: {},
    };
    const transport = new FakeTransport([
      update('toolCallStarted', { callId: 'call_invalid' }),
      serverMessage('execServerMessage', {
        id: 2,
        execId: 'tool',
        message: { case: 'mcpArgs', value: invalidArgs },
      }),
    ]);
    const openRun = vi.spyOn(transport, 'openRun');

    await expect(
      (async () => {
        for await (const event of backendWith(transport).completeStream(request)) {
          throw new Error(`Buffered validation path exposed ${event.type}`);
        }
      })(),
    ).rejects.toThrow('required property');
    expect(openRun).toHaveBeenCalledTimes(2);
  });

  it('streams ordinary text before a tool-bearing Run finishes', async () => {
    const transport = new FakeTransport('manual');
    const iterable = backendWith(transport).completeStream({
      model: 'composer-2.5',
      messages: [{ role: 'user', content: 'answer without a tool' }],
      tools: [
        {
          type: 'function',
          function: { name: 'unused', parameters: { type: 'object' } },
        },
      ],
      tool_choice: 'auto',
    });
    const iterator = iterable[Symbol.asyncIterator]();
    const firstEvent = iterator.next();
    const stream = await transport.streamOpened.promise;
    await stream.firstWrite.promise;

    stream.emit(
      'data',
      encodeConnectFrame(
        transport.codec.encode(
          'agent.v1.AgentServerMessage',
          update('textDelta', { text: 'streamed answer' }),
        ),
      ),
    );
    const deadline = AbortSignal.timeout(500);
    const earlyEvent = await Promise.race([
      firstEvent.then((event) => ({ status: 'event' as const, event })),
      new Promise<{ status: 'timeout' }>((resolve) => {
        deadline.addEventListener('abort', () => resolve({ status: 'timeout' }), { once: true });
      }),
    ]);

    stream.emit(
      'data',
      Buffer.concat([
        encodeConnectFrame(
          transport.codec.encode(
            'agent.v1.AgentServerMessage',
            update('turnEnded', { inputTokens: 2, outputTokens: 2 }),
          ),
        ),
        encodeConnectFrame(Buffer.from('{}'), { trailer: true }),
      ]),
    );
    const eventualEvent = await firstEvent;
    expect(eventualEvent).toEqual({
      done: false,
      value: { type: 'content', text: 'streamed answer' },
    });
    expect(earlyEvent).toEqual({ status: 'event', event: eventualEvent });
    await iterator.return?.();
  });

  it('does not replay disallowed raw JSON tool payloads into streamed content', async () => {
    const transport = new FakeTransport([
      update('textDelta', {
        text: '{"tool_calls":[{"function":{"name":"unknown_tool","arguments":{}}}]}',
      }),
      update('turnEnded', { inputTokens: 2, outputTokens: 2 }),
    ]);
    const events = [];
    for await (const event of backendWith(transport).completeStream({
      model: 'composer-2.5',
      messages: [{ role: 'user', content: 'answer or call allowed_tool' }],
      tools: [
        {
          type: 'function',
          function: { name: 'allowed_tool', parameters: { type: 'object' } },
        },
      ],
      tool_choice: 'auto',
    }))
      events.push(event);

    expect(
      events
        .filter((event) => event.type === 'content')
        .map((event) => event.text)
        .join(''),
    ).toBe('');
  });

  it('streams raw JSON as ordinary content when tool choice is none', async () => {
    const rawJson =
      '{"tool_calls":[{"function":{"name":"disabled_tool","arguments":{"value":"text"}}}]}';
    const transport = new FakeTransport([
      update('textDelta', { text: rawJson }),
      update('turnEnded', { inputTokens: 2, outputTokens: 2 }),
    ]);
    const events = [];
    for await (const event of backendWith(transport).completeStream({
      model: 'composer-2.5',
      messages: [{ role: 'user', content: 'return JSON as text' }],
      tools: [
        {
          type: 'function',
          function: { name: 'disabled_tool', parameters: { type: 'object' } },
        },
      ],
      tool_choice: 'none',
    }))
      events.push(event);

    expect(
      events
        .filter((event) => event.type === 'content')
        .map((event) => event.text)
        .join(''),
    ).toBe(rawJson);
  });

  it('recovers valid text markers as native OpenAI tool calls', async () => {
    const toolRequest = {
      model: 'claude-opus-5-high',
      messages: [{ role: 'user' as const, content: 'call echo' }],
      tools: [
        {
          type: 'function' as const,
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
      tool_choice: 'auto' as const,
    };
    const transport = new FakeTransport([
      update('textDelta', {
        text: '[TOOL_CALLS: [{"function":{"name":"echo_value","arguments":{"value":"RECOVERED"}}}]]',
      }),
      update('turnEnded', { inputTokens: 4, outputTokens: 2 }),
    ]);
    const result = await backendWith(transport).complete(toolRequest);

    expect(result).toMatchObject({
      content: null,
      tool_calls: [
        {
          type: 'function',
          function: { name: 'echo_value', arguments: '{"value":"RECOVERED"}' },
        },
      ],
    });
  });

  it('ends and cancels a stalled Run stream on abort', async () => {
    const transport = new FakeTransport('stall');
    const backend = backendWith(transport);
    const controller = new AbortController();
    const completion = backend.complete(
      { model: 'composer-2.5', messages: [{ role: 'user', content: 'wait' }] },
      controller.signal,
    );
    const streamDeadline = AbortSignal.timeout(500);
    const stream = await Promise.race([
      transport.streamOpened.promise,
      new Promise<never>((_, reject) => {
        streamDeadline.addEventListener(
          'abort',
          () => reject(new Error('Run stream did not open before deadline')),
          { once: true },
        );
      }),
    ]);
    const writeDeadline = AbortSignal.timeout(500);
    await Promise.race([
      stream.firstWrite.promise,
      new Promise<never>((_, reject) => {
        writeDeadline.addEventListener(
          'abort',
          () => reject(new Error('Run request was not written before deadline')),
          { once: true },
        );
      }),
    ]);
    controller.abort();
    await expect(completion).rejects.toMatchObject({ name: 'AbortError' });
    expect(stream.writableEnded).toBe(true);
    expect(stream.destroyed).toBe(true);
  });

  it('does not open a Run after the caller aborts during discovery', async () => {
    const transport = new FakeTransport([]);
    const discoveryStarted = deferred();
    const discovery = deferred<Buffer>();
    vi.spyOn(transport, 'unary').mockImplementation(async (path) => {
      if (!path.includes('GetServerConfig')) return Buffer.alloc(0);
      discoveryStarted.resolve();
      return discovery.promise;
    });
    const openRun = vi.spyOn(transport, 'openRun');
    const backend = backendWith(transport);
    const controller = new AbortController();
    const completion = backend.complete(
      { model: 'composer-2.5', messages: [{ role: 'user', content: 'wait' }] },
      controller.signal,
    );
    await discoveryStarted.promise;

    controller.abort();
    const deadline = AbortSignal.timeout(100);
    const outcome = await Promise.race([
      completion.then(
        () => 'resolved',
        (error: unknown) => (error instanceof Error ? error.name : 'rejected'),
      ),
      new Promise<string>((resolve) => {
        deadline.addEventListener('abort', () => resolve('pending'), { once: true });
      }),
    ]);
    discovery.resolve(
      transport.codec.encode('aiserver.v1.GetServerConfigResponse', {
        agentUrlConfig: { agentnUrl: 'https://agent.test' },
      }),
    );
    await completion.catch(() => undefined);

    expect(outcome).toBe('AbortError');
    expect(openRun).not.toHaveBeenCalled();
  });

  it('retries a transport failure before any response becomes visible', async () => {
    const transport = new FakeTransport('manual');
    let attempts = 0;
    vi.spyOn(transport, 'openRun').mockImplementation(async () => {
      attempts += 1;
      const stream = new FakeRunStream((active) => {
        active.emit('response', { ':status': 200 });
        if (attempts === 1) {
          active.destroy(
            Object.assign(new Error('GOAWAY received'), {
              code: 'ERR_HTTP2_GOAWAY_SESSION',
            }),
          );
          return;
        }
        const frames = [
          update('textDelta', { text: 'recovered' }),
          update('turnEnded', { inputTokens: 1, outputTokens: 1 }),
        ].map((messageValue) =>
          encodeConnectFrame(transport.codec.encode('agent.v1.AgentServerMessage', messageValue)),
        );
        frames.push(encodeConnectFrame(Buffer.from('{}'), { trailer: true }));
        active.emit('data', Buffer.concat(frames));
      });
      transport.stream = stream;
      return stream;
    });

    const result = await backendWith(transport).complete({
      model: 'composer-2.5',
      messages: [{ role: 'user', content: 'recover once' }],
    });

    expect(result.content).toBe('recovered');
    expect(attempts).toBe(2);
  });

  it('retries a clean stream close without a trailer', async () => {
    const transport = new FakeTransport('manual');
    let attempts = 0;
    vi.spyOn(transport, 'openRun').mockImplementation(async () => {
      attempts += 1;
      const stream = new FakeRunStream((active) => {
        active.emit('response', { ':status': 200 });
        if (attempts === 1) {
          active.emit('close');
          return;
        }
        active.emit(
          'data',
          Buffer.concat([
            encodeConnectFrame(
              transport.codec.encode(
                'agent.v1.AgentServerMessage',
                update('textDelta', { text: 'closed stream recovered' }),
              ),
            ),
            encodeConnectFrame(
              transport.codec.encode(
                'agent.v1.AgentServerMessage',
                update('turnEnded', { inputTokens: 1, outputTokens: 1 }),
              ),
            ),
            encodeConnectFrame(Buffer.from('{}'), { trailer: true }),
          ]),
        );
      });
      transport.stream = stream;
      return stream;
    });

    const result = await backendWith(transport).complete({
      model: 'composer-2.5',
      messages: [{ role: 'user', content: 'recover a clean close' }],
    });

    expect(result.content).toBe('closed stream recovered');
    expect(attempts).toBe(2);
  });

  it('retries after filtered content but not after client-visible content', async () => {
    const hiddenTransport = new FakeTransport('manual');
    let hiddenAttempts = 0;
    vi.spyOn(hiddenTransport, 'openRun').mockImplementation(async () => {
      hiddenAttempts += 1;
      const stream = new FakeRunStream((active) => {
        active.emit('response', { ':status': 200 });
        if (hiddenAttempts === 1) {
          active.emit(
            'data',
            encodeConnectFrame(
              hiddenTransport.codec.encode(
                'agent.v1.AgentServerMessage',
                update('textDelta', { text: '[TOOL_' }),
              ),
            ),
          );
          active.destroy(Object.assign(new Error('reset'), { code: 'ECONNRESET' }));
          return;
        }
        active.emit(
          'data',
          Buffer.concat([
            encodeConnectFrame(
              hiddenTransport.codec.encode(
                'agent.v1.AgentServerMessage',
                update('textDelta', { text: 'retry visible' }),
              ),
            ),
            encodeConnectFrame(
              hiddenTransport.codec.encode(
                'agent.v1.AgentServerMessage',
                update('turnEnded', { inputTokens: 1, outputTokens: 1 }),
              ),
            ),
            encodeConnectFrame(Buffer.from('{}'), { trailer: true }),
          ]),
        );
      });
      hiddenTransport.stream = stream;
      return stream;
    });
    const hiddenEvents = [];
    for await (const event of backendWith(hiddenTransport).completeStream({
      model: 'composer-2.5',
      messages: [{ role: 'user', content: 'retry hidden marker' }],
      tools: [{ type: 'function', function: { name: 'unused', parameters: {} } }],
      tool_choice: 'auto',
    })) {
      hiddenEvents.push(event);
    }
    expect(hiddenAttempts).toBe(2);
    expect(hiddenEvents).toContainEqual({ type: 'content', text: 'retry visible' });

    const visibleTransport = new FakeTransport('manual');
    let visibleAttempts = 0;
    vi.spyOn(visibleTransport, 'openRun').mockImplementation(async () => {
      visibleAttempts += 1;
      const stream = new FakeRunStream((active) => {
        active.emit('response', { ':status': 200 });
        active.emit(
          'data',
          encodeConnectFrame(
            visibleTransport.codec.encode(
              'agent.v1.AgentServerMessage',
              update('textDelta', { text: 'already visible' }),
            ),
          ),
        );
        active.destroy(Object.assign(new Error('reset'), { code: 'ECONNRESET' }));
      });
      visibleTransport.stream = stream;
      return stream;
    });
    const iterable = backendWith(visibleTransport).completeStream({
      model: 'composer-2.5',
      messages: [{ role: 'user', content: 'do not replay' }],
    });
    const iterator = iterable[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: 'content', text: 'already visible' },
    });
    await expect(iterator.next()).rejects.toThrow('reset');
    expect(visibleAttempts).toBe(1);
  });

  it('recognizes nested and resource-exhausted retryable failures', () => {
    expect(
      isRetryableCursorTransportError(
        Object.assign(new Error('fetch failed'), {
          cause: Object.assign(new Error('lookup failed'), { code: 'ENOTFOUND' }),
        }),
      ),
    ).toBe(true);
    expect(
      isRetryableCursorTransportError(new ConnectRpcError('Error', 'resource_exhausted')),
    ).toBe(true);
    expect(
      isRetryableCursorTransportError(
        new ConnectRpcError('quota', 'resource_exhausted', [
          { value: { errorType: 'PRO_USER_USAGE_LIMIT' } },
        ]),
      ),
    ).toBe(false);
    expect(
      isRetryableCursorTransportError(
        Object.assign(new Error('Session closed with error code 2'), {
          code: 'ERR_HTTP2_SESSION_ERROR',
        }),
      ),
    ).toBe(true);
    expect(
      isRetryableCursorTransportError(
        Object.assign(new Error('premature close'), {
          code: 'ERR_STREAM_PREMATURE_CLOSE',
        }),
      ),
    ).toBe(true);
  });
});

describe('Cursor API structured history', () => {
  const liveCodec = new ProtoCodec(loadProtoDescriptors());
  const lookupTool = {
    type: 'function' as const,
    function: { name: 'lookup_code', parameters: { type: 'object' } },
  };
  const twoRoundMessages: ChatCompletionRequest['messages'] = [
    { role: 'system', content: 'You are the oracle keeper.' },
    { role: 'developer', content: 'Follow the harness contract.' },
    { role: 'user', content: '  look up the seed  ' },
    {
      role: 'assistant',
      content: 'Checking now.',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'lookup_code', arguments: '{"file":"seed.ts"}' },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'call_1', content: 'seed=20260818' },
    { role: 'user', content: 'report the seed' },
  ];

  function decodedTurn(history: CursorHistory, index: number) {
    const turnId = required(history.conversationState.turns[index], 'turn id');
    const turn = liveCodec.decode(
      'agent.v1.ConversationTurnStructure',
      required(history.blobs.get(turnId.toString('hex')), 'turn blob'),
    );
    const agentTurn = objectAt(turn, ['turn', 'value']);
    return {
      userMessage: liveCodec.decode(
        'agent.v1.UserMessage',
        required(
          history.blobs.get(bufferAt(agentTurn.userMessage).toString('hex')),
          'user message blob',
        ),
      ),
      steps: arrayAt(agentTurn.steps).map((stepId) =>
        liveCodec.decode(
          'agent.v1.ConversationStep',
          required(history.blobs.get(bufferAt(stepId).toString('hex')), 'conversation step blob'),
        ),
      ),
    };
  }

  it('round-trips every message role and tool pair through root prompt blobs', () => {
    const history = buildCursorHistory(
      { model: 'composer-2.5', messages: twoRoundMessages },
      liveCodec,
    );

    expect(rootPromptEntries(history)).toEqual([
      { role: 'system', content: 'You are the oracle keeper.' },
      { role: 'system', content: 'Follow the harness contract.' },
      { role: 'user', content: [{ type: 'text', text: 'look up the seed' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Checking now.' },
          {
            type: 'tool-call',
            toolCallId: 'call_1',
            toolName: 'lookup_code',
            args: { file: 'seed.ts' },
          },
        ],
      },
      {
        role: 'tool',
        id: 'call_1',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call_1',
            toolName: 'lookup_code',
            result: 'seed=20260818',
          },
        ],
      },
    ]);

    const turn = decodedTurn(history, 0);
    expect(turn.userMessage).toMatchObject({ text: 'look up the seed' });
    expect(turn.userMessage.selectedContext).toBeUndefined();
    expect(turn.steps).toHaveLength(2);
    expect(turn.steps[0]).toEqual({
      message: { case: 'assistantMessage', value: { text: 'Checking now.' } },
    });
    expect(turn.steps[1]).toEqual({
      message: {
        case: 'toolCall',
        value: {
          tool: {
            case: 'mcpToolCall',
            value: {
              args: {
                name: 'lookup_code',
                args: {
                  file: { kind: { case: 'stringValue', value: 'seed.ts' } },
                },
                toolCallId: 'call_1',
                providerIdentifier: 'bridge',
                toolName: 'lookup_code',
              },
              result: {
                result: {
                  case: 'success',
                  value: {
                    content: [{ content: { case: 'text', value: { text: 'seed=20260818' } } }],
                  },
                },
              },
            },
          },
          toolCallId: 'call_1',
        },
      },
    });
  });

  it('preserves an empty tool result in both structures', () => {
    const history = buildCursorHistory(
      {
        model: 'composer-2.5',
        messages: [
          { role: 'user', content: 'run it' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'call_empty',
                type: 'function',
                function: { name: 'lookup_code', arguments: '{}' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call_empty', content: '' },
        ],
      },
      liveCodec,
    );

    const entries = rootPromptEntries(history);
    expect(entries.at(-1)).toEqual({
      role: 'tool',
      id: 'call_empty',
      content: [
        { type: 'tool-result', toolCallId: 'call_empty', toolName: 'lookup_code', result: '' },
      ],
    });
    const turn = decodedTurn(history, 0);
    expect(
      valueAt(turn.steps, [
        0,
        'message',
        'value',
        'tool',
        'value',
        'result',
        'result',
        'value',
        'content',
      ]),
    ).toEqual([{ content: { case: 'text', value: { text: '' } } }]);
  });

  it('omits tagged thinking and reasoning at the HTTP boundary and replays no thinking', () => {
    const normalizedAssistant = flattenMessageContent([
      { type: 'text', text: 'VISIBLE_ASSISTANT_TEXT' },
      { type: 'thinking', text: 'PRIVATE_CHAIN' },
      { type: 'reasoning', content: 'PRIVATE_CHAIN_REASONING' },
    ]);
    expect(normalizedAssistant).not.toContain('PRIVATE_CHAIN');
    expect(normalizedAssistant).toContain('VISIBLE_ASSISTANT_TEXT');

    const history = buildCursorHistory(
      {
        model: 'composer-2.5',
        messages: [
          {
            role: 'user',
            content: '[image omitted: cursor composer bridge is text-only] describe it',
          },
          { role: 'assistant', content: normalizedAssistant },
          { role: 'user', content: 'now summarize' },
        ],
      },
      liveCodec,
    );
    const entries = rootPromptEntries(history);
    const partTypes = entries.flatMap((entry) =>
      Array.isArray(entry.content) ? entry.content.map((part) => testRecord(part).type) : [],
    );
    expect(partTypes.every((type) => type === 'text' || type === 'tool-call')).toBe(true);
    expect(entries.find((entry) => entry.role === 'user')).toEqual({
      role: 'user',
      content: [
        {
          type: 'text',
          text: '[image omitted: cursor composer bridge is text-only] describe it',
        },
      ],
    });
    const action = testRecord(testRecord(testRecord(history.action).action).value);
    expect(testRecord(action.userMessage).text).toBe('now summarize');

    const assistantEntry = entries.find((entry) => entry.role === 'assistant');
    expect(assistantEntry?.content).toEqual([{ type: 'text', text: 'VISIBLE_ASSISTANT_TEXT' }]);
    const serializedBlobs = [...history.blobs.values()].map((blob) => blob.toString('utf8'));
    expect(serializedBlobs.join('\n')).not.toContain('PRIVATE_CHAIN');
    const turn = decodedTurn(history, 0);
    expect(turn.userMessage.text).toContain('image omitted');
    const firstTurn = required(history.conversationState.turns[0], 'first turn');
    const turnBlobText = required(
      history.blobs.get(firstTurn.toString('hex')),
      'first turn blob',
    ).toString('hex');
    expect(turnBlobText).not.toContain(Buffer.from('PRIVATE_CHAIN').toString('hex'));
    expect(
      turn.steps.some(
        (step: Record<string, unknown>) => testRecord(step.message).case === 'assistantMessage',
      ),
    ).toBe(true);
  });

  it('uses the last user message as the action input and resumes after tool results', () => {
    const withUser = buildCursorHistory(
      { model: 'composer-2.5', messages: twoRoundMessages },
      liveCodec,
    );
    expect(withUser.action).toMatchObject({
      action: { case: 'userMessageAction', value: { userMessage: { text: 'report the seed' } } },
    });

    const resuming = buildCursorHistory(
      { model: 'composer-2.5', messages: twoRoundMessages.slice(0, -1) },
      liveCodec,
    );
    expect(resuming.action).toEqual({ action: { case: 'resumeAction', value: {} } });
    expect(resuming.conversationState.turns).toHaveLength(1);
  });

  it('rebuilds identical structures deterministically per request', () => {
    const request = { model: 'composer-2.5', messages: twoRoundMessages };
    const first = buildCursorHistory(request, liveCodec);
    const second = buildCursorHistory(request, liveCodec);
    expect(first.conversationState.rootPromptMessagesJson.map((id) => id.toString('hex'))).toEqual(
      second.conversationState.rootPromptMessagesJson.map((id) => id.toString('hex')),
    );
    expect(first.conversationState.turns.map((id) => id.toString('hex'))).toEqual(
      second.conversationState.turns.map((id) => id.toString('hex')),
    );
    expect([...first.blobs.entries()].sort()).toEqual([...second.blobs.entries()].sort());

    const changed = buildCursorHistory(
      {
        model: 'composer-2.5',
        messages: twoRoundMessages.map((message, index) =>
          index === 4
            ? { role: 'tool' as const, tool_call_id: 'call_1', content: 'seed=changed' }
            : message,
        ),
      },
      liveCodec,
    );
    expect(changed.conversationState.rootPromptMessagesJson).not.toEqual(
      first.conversationState.rootPromptMessagesJson,
    );
  });

  it('pairs tool results with request-local wire tool names', () => {
    const mapped = mapCursorApiToolRequest({
      model: 'composer-2.5',
      messages: twoRoundMessages.slice(2),
      tools: [lookupTool],
    });
    const history = buildCursorHistory(mapped.request, liveCodec);
    const entries = rootPromptEntries(history);
    const toolEntry = entries.find((entry) => entry.role === 'tool');
    expect(toolEntry).toMatchObject({
      id: 'call_1',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call_1',
          toolName: 'bridge-lookup_code',
          result: 'seed=20260818',
        },
      ],
    });
    expect(entries.find((entry) => entry.role === 'assistant')?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'tool-call',
          toolName: 'bridge-lookup_code',
          toolCallId: 'call_1',
        }),
      ]),
    );
  });

  it('serves structured history blobs to Cursor KV requests on the run wire', async () => {
    const transport = new FakeTransport('manual');
    const completion = backendWith(transport).complete({
      model: 'composer-2.5',
      messages: twoRoundMessages,
    });
    await transport.streamOpened.promise;
    const stream = required(transport.stream, 'history run stream');
    await stream.firstWrite.promise;
    const decoder = new ConnectFrameDecoder();
    const [firstFrame] = decoder.push(required(stream.writes[0], 'first history write'));
    const run = objectAt(
      transport.codec.decode(
        'agent.v1.AgentClientMessage',
        required(
          required(firstFrame, 'first history frame').payload,
          'first history frame payload',
        ),
      ),
      ['message', 'value'],
    );
    expect(valueAt(run, ['action', 'action', 'case'])).toBe('userMessageAction');
    expect(valueAt(run, ['action', 'action', 'value', 'userMessage', 'text'])).toBe(
      'report the seed',
    );
    expect(
      arrayAt(run, ['conversationState', 'rootPromptMessagesJson']).length,
    ).toBeGreaterThanOrEqual(2);
    expect(arrayAt(run, ['conversationState', 'turns']).length).toBe(1);

    stream.emit(
      'data',
      encodeConnectFrame(
        transport.codec.encode(
          'agent.v1.AgentServerMessage',
          serverMessage('kvServerMessage', {
            id: 7,
            message: {
              case: 'getBlobArgs',
              value: { blobId: valueAt(run, ['conversationState', 'rootPromptMessagesJson', 0]) },
            },
          }),
        ),
      ),
    );
    const [replyFrame] = decoder.push(required(stream.writes[1], 'history reply write'));
    const clientMessage = objectAt(
      transport.codec.decode(
        'agent.v1.AgentClientMessage',
        required(required(replyFrame, 'history reply frame').payload, 'history reply payload'),
      ),
      ['message'],
    );
    expect(clientMessage.case).toBe('kvClientMessage');
    const blob = JSON.parse(
      bufferAt(clientMessage, ['value', 'message', 'value', 'blobData']).toString('utf8'),
    );
    expect(blob.role).toBe('system');

    stream.emit(
      'data',
      Buffer.concat([
        encodeConnectFrame(
          transport.codec.encode(
            'agent.v1.AgentServerMessage',
            serverMessage('interactionUpdate', {
              message: { case: 'textDelta', value: { text: 'history ready' } },
            }),
          ),
        ),
        encodeConnectFrame(Buffer.alloc(0), { trailer: true }),
      ]),
    );
    await expect(completion).resolves.toMatchObject({ content: 'history ready' });
  });
});
