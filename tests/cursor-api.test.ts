import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CursorAuthProvider } from '../src/backend/cursor-api/auth.js';
import {
  ConnectFrameDecoder,
  ConnectRpcError,
  encodeConnectFrame,
} from '../src/backend/cursor-api/connect-frame.js';
import { CURSOR_API_STARTUP_SEQUENCE, CursorApiBackend } from '../src/backend/cursor-api/index.js';
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
import {
  CURSOR_BOOTSTRAP_UNARY_HEADER_NAMES,
  CURSOR_RUN_HEADER_NAMES,
  CURSOR_UNARY_HEADER_NAMES,
  NodeCursorApiTransport,
  type CursorApiTransport,
  type CursorRunStream,
} from '../src/backend/cursor-api/transport.js';
import type { BridgeConfig } from '../src/config.js';

const scalar = (
  no: number,
  localName: string,
  type: number,
  options: Partial<ProtoFieldDescriptor> = {},
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
  options: Partial<ProtoFieldDescriptor> = {},
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
      oneof(7, 'clientHeartbeat', 'agent.v1.ClientHeartbeat'),
    ),
    'agent.v1.AgentRunRequest': fields(
      message(1, 'conversationState', 'agent.v1.Empty'),
      message(2, 'action', 'agent.v1.ConversationAction'),
      message(9, 'requestedModel', 'agent.v1.RequestedModel'),
      scalar(5, 'conversationId', 9),
      scalar(16, 'conversationGroupId', 9),
      scalar(25, 'runId', 9),
    ),
    'agent.v1.Empty': fields(),
    'agent.v1.ConversationAction': fields(
      oneof(1, 'userMessageAction', 'agent.v1.UserMessageAction', 'action'),
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
      oneof(4, 'thinkingDelta', 'agent.v1.ThinkingDeltaUpdate'),
      oneof(7, 'partialToolCall', 'agent.v1.PartialToolCallUpdate'),
      oneof(14, 'turnEnded', 'agent.v1.TurnEndedUpdate'),
    ),
    'agent.v1.TextDeltaUpdate': fields(scalar(1, 'text', 9)),
    'agent.v1.ToolCallStartedUpdate': fields(scalar(1, 'callId', 9)),
    'agent.v1.ThinkingDeltaUpdate': fields(scalar(1, 'text', 9)),
    'agent.v1.PartialToolCallUpdate': fields(scalar(1, 'callId', 9)),
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

const config: BridgeConfig = {
  host: '127.0.0.1',
  port: 9996,
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
  constructor(private readonly onFirstWrite: (stream: FakeRunStream) => void) {
    super();
  }
  write(chunk: Uint8Array): boolean {
    this.writes.push(Buffer.from(chunk));
    if (this.writes.length === 1) queueMicrotask(() => this.onFirstWrite(this));
    return true;
  }
  destroy(error?: Error): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (error) this.emit('error', error);
    this.emit('close');
  }
  close(): void {
    this.writableEnded = true;
  }
}

class FakeTransport implements CursorApiTransport {
  readonly codec = new ProtoCodec(descriptors);
  stream?: FakeRunStream;
  constructor(private readonly script: Array<Record<string, unknown>> | 'stall') {}
  async unary(path: string): Promise<Buffer> {
    if (path.includes('GetServerConfig')) {
      return this.codec.encode('aiserver.v1.GetServerConfigResponse', {
        agentUrlConfig: { agentnUrl: 'https://agent.test' },
      });
    }
    return Buffer.alloc(0);
  }
  async openRun(): Promise<CursorRunStream> {
    this.stream = new FakeRunStream((stream) => {
      stream.emit('response', { ':status': 200 });
      if (this.script === 'stall') return;
      const frames = this.script.map((messageValue) =>
        encodeConnectFrame(this.codec.encode('agent.v1.AgentServerMessage', messageValue)),
      );
      frames.push(encodeConnectFrame(Buffer.from('{}'), { trailer: true }));
      stream.emit('data', Buffer.concat(frames));
    });
    return this.stream;
  }
}

const serverMessage = (caseName: string, value: Record<string, unknown>) => ({
  message: { case: caseName, value },
});
const update = (caseName: string, value: Record<string, unknown>) =>
  serverMessage('interactionUpdate', { message: { case: caseName, value } });

function backendWith(transport: FakeTransport) {
  return new CursorApiBackend(config, {
    descriptors,
    transport,
    auth: new CursorAuthProvider({ environment: { CURSOR_AUTH_TOKEN: 'token' } }),
  });
}

function jwt(exp: number): string {
  return `x.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.y`;
}

describe('Cursor API Connect framing', () => {
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
        const headers = init?.headers as Record<string, string> | undefined;
        expect(headers?.authorization).toBe('Bearer api-key');
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
    outdated.messages['agent.v1.InteractionUpdate']!.fields = outdated.messages[
      'agent.v1.InteractionUpdate'
    ]!.fields.filter((field) => !['partialToolCall', 'toolCallStarted'].includes(field.localName));
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
    let runHeaders: Record<string, string> = {};
    const session = Object.assign(new EventEmitter(), {
      closed: false,
      destroyed: false,
      close() {
        this.closed = true;
      },
      request(headers: Record<string, string>) {
        runHeaders = headers;
        return new FakeRunStream(() => undefined);
      },
    });
    const transport = new NodeCursorApiTransport({
      auth: new CursorAuthProvider({ environment: { CURSOR_AUTH_TOKEN: 'token' } }),
      clientVersion: 'cli-2026.08.11-e8db854',
      fetch: async (_input, init) => {
        unaryHeaderSets.push(init?.headers as Record<string, string>);
        return new Response(Buffer.alloc(0), { status: 200 });
      },
      connect: (() => session) as unknown as typeof import('node:http2').connect,
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
    const decodedRun = liveCodec.decode(
      'agent.v1.AgentClientMessage',
      liveCodec.encode(
        'agent.v1.AgentClientMessage',
        runRequestMessage(
          { model: 'cursor-grok-4.6-high', messages: [{ role: 'user', content: 'hello' }] },
          'request-id',
          requestedModels,
        ),
      ),
    ).message.value;

    expect(decodedRun.requestedModel).toMatchObject({
      modelId: 'grok-4.6',
      parameters: [
        { id: 'effort', value: 'high' },
        { id: 'fast', value: 'false' },
      ],
    });
    expect(
      decodedRun.selectedSubagentModels.find(
        (model: Record<string, unknown>) => model.modelId === 'grok-4.6',
      ),
    ).toMatchObject(decodedRun.requestedModel);
  });

  it('matches captured Run and request-context field presence', () => {
    const liveCodec = new ProtoCodec(loadProtoDescriptors());
    const decodedRun = liveCodec.decode(
      'agent.v1.AgentClientMessage',
      liveCodec.encode(
        'agent.v1.AgentClientMessage',
        runRequestMessage(
          { model: 'composer-2.5', messages: [{ role: 'user', content: 'hello' }] },
          'request-id',
        ),
      ),
    ).message.value;
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
    expect(decodedRun.selectedSubagentModels).toHaveLength(10);

    const context = liveCodec.decode(
      'agent.v1.RequestContextResult',
      liveCodec.encode(
        'agent.v1.RequestContextResult',
        requestContextResult(
          { model: 'composer-2.5', messages: [{ role: 'user', content: 'hello' }] },
          '/tmp/work',
          { SHELL: '/bin/zsh' },
        ),
      ),
    ).result.value.requestContext;
    expect(context.env).toMatchObject({
      workspacePaths: ['/tmp/work'],
      shell: 'zsh',
      processWorkingDirectory: '/tmp/work',
    });
    expect(context.supportsMcpAuth).toBe(true);
    expect(context.gitRepoInfoComplete).toBe(true);
  });

  it('uses agent mode only when client tools are available', () => {
    const baseRequest = {
      model: 'composer-2.5',
      messages: [{ role: 'user' as const, content: 'hello' }],
    };
    const withoutTools = runRequestMessage(baseRequest, 'request-without-tools');
    const withTools = runRequestMessage(
      {
        ...baseRequest,
        tools: [
          {
            type: 'function' as const,
            function: {
              name: 'echo_value',
              parameters: { type: 'object' },
            },
          },
        ],
      },
      'request-with-tools',
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
            action: { value: { userMessage: { mode: 2 } } },
          },
        },
      },
    });
  });
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
    const outbound = transport.stream!.writes.flatMap((write) =>
      decoder
        .push(write)
        .map((frame) => transport.codec.decode('agent.v1.AgentClientMessage', frame.payload!)),
    );
    expect(outbound.map((item) => item.message.case)).toEqual(
      expect.arrayContaining(['runRequest', 'execClientMessage', 'kvClientMessage']),
    );
    const execCases = outbound
      .filter((item) => item.message.case === 'execClientMessage')
      .map((item) => item.message.value.message.case);
    expect(execCases).toEqual(['requestContextResult', 'shellResult']);
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
        is_error: false,
      },
    ]);

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
            name: 'echo_value',
            toolName: 'echo_value',
            providerIdentifier: 'bridge',
            toolCallId: 'call_native_1',
            args: { value: jsonToProtoValue('NATIVE_OK') },
          },
        },
      }),
    ]);
    const result = await backendWith(toolTransport).complete({
      model: 'composer-2.5',
      messages: [{ role: 'user', content: 'call echo' }],
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
      tool_choice: 'required',
    });
    expect(result.tool_calls).toEqual([
      {
        id: 'call_native_1',
        type: 'function',
        function: { name: 'echo_value', arguments: '{"value":"NATIVE_OK"}' },
      },
    ]);
    expect(toolTransport.stream?.writableEnded || toolTransport.stream?.destroyed).toBe(true);
  });

  it('recovers valid text markers as native OpenAI tool calls', async () => {
    const transport = new FakeTransport([
      update('textDelta', {
        text: '[TOOL_CALLS: [{"function":{"name":"echo_value","arguments":{"value":"RECOVERED"}}}]]',
      }),
      update('turnEnded', { inputTokens: 4, outputTokens: 2 }),
    ]);
    const result = await backendWith(transport).complete({
      model: 'claude-opus-5-high',
      messages: [{ role: 'user', content: 'call echo' }],
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
    });

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

  it('destroys a stalled Run stream on abort', async () => {
    const transport = new FakeTransport('stall');
    const backend = backendWith(transport);
    const controller = new AbortController();
    const completion = backend.complete(
      { model: 'composer-2.5', messages: [{ role: 'user', content: 'wait' }] },
      controller.signal,
    );
    await new Promise<void>((resolve) => {
      const check = () => {
        if (transport.stream?.writes.length) resolve();
        else queueMicrotask(check);
      };
      check();
    });
    controller.abort();
    await expect(completion).rejects.toMatchObject({ name: 'AbortError' });
    expect(transport.stream?.destroyed).toBe(true);
  });
});
