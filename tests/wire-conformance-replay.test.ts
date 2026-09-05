import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CursorAuthProvider } from '../src/backend/cursor-api/auth.js';
import {
  ConnectFrameDecoder,
  encodeConnectFrame,
} from '../src/backend/cursor-api/connect-frame.js';
import { CursorCredentialRouter } from '../src/backend/cursor-api/credentials.js';
import { CursorApiBackend } from '../src/backend/cursor-api/index.js';
import { loadProtoDescriptors, ProtoCodec } from '../src/backend/cursor-api/protobuf.js';
import type { CursorApiTransport, CursorRunStream } from '../src/backend/cursor-api/transport.js';
import type { ChatCompletionRequest } from '../src/backend/types.js';
import type { BridgeConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { fixtureNativeContext } from './support/native-context-fixture.js';
import { normalizeCapture } from '../scripts/wire-capture/normalize.mjs';
import { DiffInputError, diffCaptures } from '../scripts/wire-capture/diff.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const NATIVE_RUN_FIXTURE = join(HERE, 'fixtures', 'wire', 'native-cli-20260825-chat.ndjson');

const codec = new ProtoCodec(loadProtoDescriptors());

const config: BridgeConfig = {
  host: '127.0.0.1',
  port: 0,
  clientAuth: 'off',
  backend: 'cursor-api',
  defaultModel: 'composer-2.5',
  workspaceMode: 'chat-only',
  version: 'test',
};

// Exact first-turn input from the installed 2026.08.25 CLI capture.
const TOOL_SURFACE_REQUEST: ChatCompletionRequest = {
  model: 'composer-2.5',
  messages: [{ role: 'user', content: 'Reply with exactly WIRE_OK. Do not use tools.' }],
};

class WireFixtureError extends Error {
  readonly kind: string;

  constructor(kind: string, message: string) {
    super(message);
    this.name = 'WireFixtureError';
    this.kind = kind;
  }
}

interface NormalizedFrame {
  readonly schema_version?: unknown;
  readonly dir?: unknown;
  readonly decoded_fields: unknown;
  readonly error?: { readonly kind?: unknown; readonly message?: unknown };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseNormalizedNdjson(text: string, label: string): NormalizedFrame[] {
  const records: NormalizedFrame[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new WireFixtureError(
        'malformed_ndjson',
        `${label} line ${index + 1} is not valid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (!isRecord(parsed)) {
      throw new WireFixtureError(
        'malformed_ndjson',
        `${label} line ${index + 1} is not a JSON object`,
      );
    }
    records.push({
      schema_version: parsed.schema_version,
      dir: parsed.dir,
      decoded_fields: parsed.decoded_fields,
      error:
        isRecord(parsed.error) && typeof parsed.error.kind === 'string'
          ? { kind: parsed.error.kind, message: parsed.error.message }
          : undefined,
    });
  }
  if (records.length === 0) {
    throw new WireFixtureError('empty_fixture', `${label} has no NDJSON records`);
  }
  return records;
}

function loadNativeRunFixture(path = NATIVE_RUN_FIXTURE): NormalizedFrame[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new WireFixtureError(
      'missing_fixture',
      `native run fixture missing at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return parseNormalizedNdjson(text, path);
}

function collectFieldPaths(value: unknown, prefix: string, paths: Set<string>): void {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      collectFieldPaths(value[i], `${prefix}[${i}]`, paths);
    }
    return;
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      collectFieldPaths(item, prefix === '' ? key : `${prefix}.${key}`, paths);
    }
    return;
  }
  paths.add(prefix);
}

function fieldPresenceDelta(
  expected: unknown,
  actual: unknown,
): { readonly onlyInExpected: string[]; readonly onlyInActual: string[] } {
  const expectedPaths = new Set<string>();
  const actualPaths = new Set<string>();
  collectFieldPaths(expected, '', expectedPaths);
  collectFieldPaths(actual, '', actualPaths);
  return {
    onlyInExpected: [...expectedPaths].filter((path) => !actualPaths.has(path)).sort(),
    onlyInActual: [...actualPaths].filter((path) => !expectedPaths.has(path)).sort(),
  };
}

function assertFieldPresenceEqual(expected: unknown, actual: unknown, expectedLabel: string): void {
  const delta = fieldPresenceDelta(expected, actual);
  if (delta.onlyInExpected.length === 0 && delta.onlyInActual.length === 0) return;
  const missing = delta.onlyInExpected[0];
  const extra = delta.onlyInActual[0];
  const named =
    missing !== undefined
      ? `missing field path ${missing}`
      : `extra field path ${extra ?? '(unknown)'}`;
  throw new WireFixtureError(
    'field_presence',
    `${named} (expected=${expectedLabel}; only_in_expected=${JSON.stringify(
      delta.onlyInExpected,
    )}; only_in_actual=${JSON.stringify(delta.onlyInActual)})`,
  );
}

function messageCase(decoded: unknown): string | undefined {
  if (!isRecord(decoded)) return undefined;
  const message = decoded.message;
  if (!isRecord(message)) return undefined;
  return typeof message.case === 'string' ? message.case : undefined;
}

function connectWritesToRawNdjson(writes: readonly Buffer[]): string {
  const decoder = new ConnectFrameDecoder();
  const lines: string[] = [];
  let frameIndex = 0;
  for (const write of writes) {
    for (const frame of decoder.push(write)) {
      if (frame.trailer) continue;
      const payload = frame.payload;
      if (!payload) continue;
      const encoded = encodeConnectFrame(payload);
      lines.push(
        JSON.stringify({
          lane: 'yorha',
          conn: 1,
          stream: 1,
          dir: 'client',
          frame_index: frameIndex,
          flags: encoded[0] ?? 0,
          payload_b64: encoded.subarray(5).toString('base64'),
          message_type: 'agent.v1.AgentClientMessage',
        }),
      );
      frameIndex += 1;
    }
  }
  return `${lines.join('\n')}\n`;
}

class CapturingStream extends EventEmitter implements CursorRunStream {
  destroyed = false;
  writableEnded = false;
  readonly writes: Buffer[] = [];
  #started = false;

  constructor(private readonly script: (stream: CapturingStream) => void) {
    super();
  }

  write(chunk: Uint8Array): boolean {
    this.writes.push(Buffer.from(chunk));
    if (!this.#started) {
      this.#started = true;
      queueMicrotask(() => this.script(this));
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

class CapturingTransport implements CursorApiTransport {
  stream?: CapturingStream;

  constructor(private readonly script: (stream: CapturingStream) => void) {}

  async unary(path: string): Promise<Buffer> {
    if (path.includes('GetServerConfig')) {
      return codec.encode('aiserver.v1.GetServerConfigResponse', {
        agentUrlConfig: { agentnUrl: 'https://agent.test' },
      });
    }
    if (path.includes('AvailableModels')) {
      return gunzipSync(
        Buffer.from(
          readFileSync(
            join(HERE, 'fixtures', 'wire', 'native-cli-20260825-models.gzip.b64'),
            'utf8',
          ).trim(),
          'base64',
        ),
      );
    }
    if (path.includes('GetUsableModels')) {
      return codec.encode('agent.v1.GetUsableModelsResponse', {
        models: [{ modelId: 'composer-2.5', maxMode: false }],
      });
    }
    return Buffer.alloc(0);
  }

  async openRun(): Promise<CursorRunStream> {
    this.stream = new CapturingStream(this.script);
    return this.stream;
  }
}

function backendFor(transport: CapturingTransport): CursorApiBackend {
  const auth = new CursorAuthProvider({ environment: {} });
  vi.spyOn(auth, 'getToken').mockImplementation(async (credential) => credential?.apiKey ?? '');
  return new CursorApiBackend(config, {
    loadNativeContext: fixtureNativeContext,
    auth,
    transport,
    credentialRouter: new CursorCredentialRouter({
      credentials: [{ id: 'only', apiKey: 'only-token' }],
    }),
    environment: { CURSOR_BRIDGE_CURSOR_RETRY_BASE_MS: '1' },
    wait: async () => undefined,
  });
}

function scriptedUpstream(stream: CapturingStream): void {
  stream.emit('response', { ':status': 200 });
  stream.emit(
    'data',
    Buffer.concat([
      encodeConnectFrame(
        codec.encode('agent.v1.AgentServerMessage', {
          message: {
            case: 'execServerMessage',
            value: {
              message: { case: 'requestContextArgs', value: {} },
            },
          },
        }),
      ),
      encodeConnectFrame(
        codec.encode('agent.v1.AgentServerMessage', {
          message: {
            case: 'interactionUpdate',
            value: { message: { case: 'textDelta', value: { text: 'replay complete' } } },
          },
        }),
      ),
      encodeConnectFrame(
        codec.encode('agent.v1.AgentServerMessage', {
          message: {
            case: 'interactionUpdate',
            value: { message: { case: 'turnEnded', value: { inputTokens: 1, outputTokens: 1 } } },
          },
        }),
      ),
      encodeConnectFrame(Buffer.from('{}'), { trailer: true }),
    ]),
  );
}

const servers: Array<Awaited<ReturnType<typeof buildServer>>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function replayBridgeOpenAiSurface(): Promise<{
  readonly frames: NormalizedFrame[];
  readonly writes: Buffer[];
}> {
  const transport = new CapturingTransport(scriptedUpstream);
  const cursor = backendFor(transport);
  const server = await buildServer({ config, backend: cursor });
  servers.push(server);
  const response = await server.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    payload: TOOL_SURFACE_REQUEST,
  });
  if (response.statusCode >= 400) {
    throw new Error(
      `bridge OpenAI endpoint rejected replay: HTTP ${response.statusCode} ${response.body}`,
    );
  }
  const writes = transport.stream?.writes ?? [];
  const normalized = normalizeCapture(connectWritesToRawNdjson(writes));
  return { frames: parseNormalizedNdjson(normalized.output, 'bridge-replay'), writes };
}

describe('native-replay wire conformance', () => {
  it('matches actual native Run values and exec closure without bridge-only field allowances', async () => {
    const native = loadNativeRunFixture();
    const nativeRun = native[0];
    if (!nativeRun) {
      throw new WireFixtureError('empty_fixture', 'native fixture has no runRequest frame');
    }
    expect(messageCase(nativeRun.decoded_fields)).toBe('runRequest');

    const replay = await replayBridgeOpenAiSurface();
    const bridgeRun = replay.frames[0];
    if (!bridgeRun) {
      throw new WireFixtureError('empty_replay', 'bridge emitted no client frames');
    }
    expect(messageCase(bridgeRun.decoded_fields)).toBe('runRequest');

    // Compare values and presence. Only UUIDs are normalized in this first-turn fixture.
    expect(bridgeRun.decoded_fields).toEqual(nativeRun.decoded_fields);
    const controls = replay.frames.filter(
      (frame) => messageCase(frame.decoded_fields) === 'execClientControlMessage',
    );
    expect(controls).toHaveLength(1);
    expect(controls[0]?.decoded_fields).toEqual(native[1]?.decoded_fields);
  });

  it('fails with a typed error on a corrupt fixture line instead of crashing', () => {
    expect(() => parseNormalizedNdjson('{"schema_version":1,"decoded_fields":', 'corrupt')).toThrow(
      WireFixtureError,
    );
    try {
      parseNormalizedNdjson('{"schema_version":1,"decoded_fields":', 'corrupt');
      throw new Error('expected typed fixture failure');
    } catch (error) {
      expect(error).toBeInstanceOf(WireFixtureError);
      if (!(error instanceof WireFixtureError)) return;
      expect(error.kind).toBe('malformed_ndjson');
      expect(error.message).toMatch(/line 1 is not valid JSON/);
    }
    expect(() => diffCaptures('{"schema_version":1,"decoded_fields":', '{"a":1}\n')).toThrow(
      DiffInputError,
    );
  });

  it('names the missing field path when a declared tool is dropped from the replay fixture', () => {
    const withTools = {
      message: {
        case: 'execClientMessage',
        value: {
          message: {
            case: 'requestContextResult',
            value: {
              result: {
                case: 'success',
                value: {
                  requestContext: {
                    supportsMcpAuth: true,
                    tools: [
                      {
                        name: 'echo_value',
                        toolName: 'echo_value',
                        providerIdentifier: 'bridge',
                      },
                    ],
                  },
                },
              },
            },
          },
        },
      },
    };
    const droppedTool = structuredClone(withTools);
    const requestContext = droppedTool.message.value.message.value.result.value.requestContext;
    requestContext.tools = [];

    expect(() => assertFieldPresenceEqual(withTools, droppedTool, 'native-with-tools')).toThrow(
      WireFixtureError,
    );
    try {
      assertFieldPresenceEqual(withTools, droppedTool, 'native-with-tools');
    } catch (error) {
      expect(error).toBeInstanceOf(WireFixtureError);
      if (!(error instanceof WireFixtureError)) return;
      expect(error.kind).toBe('field_presence');
      expect(error.message).toMatch(
        /missing field path message\.value\.message\.value\.result\.value\.requestContext\.tools\[0\]/,
      );
    }
  });
});
