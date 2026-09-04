import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CursorAuthProvider } from '../../src/backend/cursor-api/auth.js';
import { CursorApiBackend } from '../../src/backend/cursor-api/backend.js';
import type { CursorApiCredential } from '../../src/backend/cursor-api/credentials.js';
import type { ChatCompletionRequest, ChatMessage, ToolCall } from '../../src/backend/types.js';
import type { BridgeConfig } from '../../src/config.js';
import { buildServer } from '../../src/server.js';
import { array, bounded, NativeParityTransport, object, text } from './native-parity-wire.js';
import type { Dict } from './native-parity-wire.js';

export interface HttpReceipt {
  readonly method: string;
  readonly path: string;
  readonly requestBody?: unknown;
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}
export interface CleanupReceipt {
  readonly listening: boolean;
  readonly transportStopped: boolean;
  readonly openStreams: number;
  readonly temporaryConfigRemoved: boolean;
}
export interface ScenarioReceipt {
  readonly name: string;
  readonly http: HttpReceipt[];
  readonly upstream: unknown;
  readonly cleanup: CleanupReceipt;
  readonly pass: boolean;
  readonly error?: string;
}
export type EvidenceSink = (receipt: ScenarioReceipt) => void | Promise<void>;

// Observes a public mutation seam without replacing any backend behavior.
class ObservedBackend extends CursorApiBackend {
  readonly changes = new EventEmitter();
  override updateCredentials(credentials: CursorApiCredential[]): void {
    super.updateCredentials(credentials);
    this.changes.emit('updated');
  }
}
export async function fixture(singleAccount = false) {
  const directory = await mkdtemp(join(tmpdir(), 'native-parity-http-'));
  const credentials = ['A', ...(singleAccount ? [] : ['B'])].map((id) => ({
    id,
    apiKey: 'key-' + id,
    weight: 1,
    enabled: true,
  }));
  const config: BridgeConfig = {
    host: '127.0.0.1',
    port: 0,
    apiKey: 'synthetic-client-key',
    clientAuth: 'on',
    backend: 'cursor-api',
    defaultModel: 'composer-2.5',
    workspaceMode: 'chat-only',
    version: 'test',
    dashboardConfigPath: join(directory, 'dashboard.json'),
    dashboardConfig: {
      credentials,
      credentialPolicy: { routingPolicy: 'round_robin', failoverOn: 'auth' },
    },
    cursorApiCredentials: credentials,
  };
  const transport = new NativeParityTransport();
  const backend = new ObservedBackend(config, {
    environment: {},
    transport,
    auth: new CursorAuthProvider({
      environment: {},
      fetch: async (_url, init) => {
        const authorization = new Headers(init?.headers).get('authorization');
        assert.ok(authorization && /^Bearer key-(A|B|A2)$/.test(authorization));
        return new Response(
          JSON.stringify({ accessToken: authorization.replace('Bearer key-', 'token-') }),
        );
      },
    }),
    fetch: async () => {
      throw new Error('Unexpected account-usage network request');
    },
  });
  const server = await buildServer({ config, backend });
  try {
    await server.listen({ host: '127.0.0.1', port: 0 });
  } catch (error) {
    await server.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  const address = server.server.address();
  assert.ok(address && typeof address !== 'string');
  const url = 'http://127.0.0.1:' + address.port;
  const http: HttpReceipt[] = [];
  return {
    transport,
    backend,
    http,
    url,
    async request(
      path: string,
      body?: unknown,
      method = body === undefined ? 'GET' : 'POST',
    ): Promise<HttpReceipt> {
      const response = await fetch(url + path, {
        method,
        signal: AbortSignal.timeout(5_000),
        headers: {
          authorization: 'Bearer synthetic-client-key',
          'content-type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const receipt: HttpReceipt = {
        method,
        path,
        ...(body === undefined ? {} : { requestBody: body }),
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: await response.text(),
      };
      http.push(receipt);
      return receipt;
    },
    async close(): Promise<CleanupReceipt> {
      await bounded(server.close());
      await rm(directory, { recursive: true, force: true });
      return {
        listening: server.server.listening,
        transportStopped: transport.stopped,
        openStreams: transport.runs.filter(
          (run) => !run.stream.destroyed && !run.stream.writableEnded,
        ).length,
        temporaryConfigRemoved: !existsSync(directory),
      };
    },
  };
}
export type HttpFixture = Awaited<ReturnType<typeof fixture>>;
export async function scenario(
  name: string,
  action: (f: HttpFixture) => Promise<void>,
  sink?: EvidenceSink,
  singleAccount = false,
): Promise<void> {
  const f = await fixture(singleAccount);
  let failure: unknown;
  try {
    await action(f);
  } catch (error) {
    failure = error;
  }
  const cleanup = await f.close();
  await sink?.({
    name,
    http: f.http,
    upstream: {
      unary: f.transport.unaryRequests,
      runs: f.transport.runs.map(({ endpoint, token, requestId, writes, roots }) => ({
        endpoint,
        token,
        requestId,
        writes,
        roots,
      })),
    },
    cleanup,
    pass: failure === undefined,
    ...(failure === undefined
      ? {}
      : { error: failure instanceof Error ? (failure.stack ?? failure.message) : String(failure) }),
  });
  assert.deepEqual(cleanup, {
    listening: false,
    transportStopped: true,
    openStreams: 0,
    temporaryConfigRemoved: true,
  });
  if (failure !== undefined) throw failure;
}
export function initial(stream = false): ChatCompletionRequest {
  return {
    model: 'composer-2.5',
    stream,
    messages: [
      { role: 'system', content: 'fixture-system' },
      { role: 'user', content: 'fixture-question' },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'echo_value',
          description: 'Echo fixture value',
          parameters: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
          },
        },
      },
    ],
    max_tool_calls: 1,
  };
}
export function success(receipt: HttpReceipt): Dict {
  assert.equal(receipt.status, 200, receipt.body);
  return object(JSON.parse(receipt.body));
}
export function completion(receipt: HttpReceipt): ChatMessage {
  assert.equal(receipt.status, 200, receipt.body);
  const calls = new Map<number, ToolCall>();
  let content = '';
  if (receipt.headers['content-type']?.includes('text/event-stream')) {
    const frames = receipt.body
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice(6));
    assert.equal(frames.at(-1), '[DONE]');
    let finishReason: unknown;
    for (const raw of frames.slice(0, -1)) {
      const chunk = object(JSON.parse(raw));
      assert.equal(chunk.error, undefined, raw);
      for (const value of array(chunk.choices)) {
        const choice = object(value);
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = object(choice.delta);
        if (typeof delta.content === 'string') content += delta.content;
        for (const value of array(delta.tool_calls ?? [])) {
          const call = object(value);
          assert.equal(typeof call.index, 'number');
          const index = Number(call.index);
          const fn = object(call.function ?? {});
          const previous = calls.get(index);
          calls.set(index, {
            id: typeof call.id === 'string' ? call.id : text(previous?.id),
            type: 'function',
            function: {
              name: typeof fn.name === 'string' ? fn.name : text(previous?.function.name),
              arguments:
                (previous?.function.arguments ?? '') +
                (typeof fn.arguments === 'string' ? fn.arguments : ''),
            },
          });
        }
      }
    }
    assert.equal(finishReason, calls.size ? 'tool_calls' : 'stop');
  } else {
    const choice = object(array(success(receipt).choices)[0]);
    const message = object(choice.message);
    content = message.content === null ? '' : text(message.content);
    for (const [index, value] of array(message.tool_calls ?? []).entries()) {
      const call = object(value);
      const fn = object(call.function);
      calls.set(index, {
        id: text(call.id),
        type: 'function',
        function: { name: text(fn.name), arguments: text(fn.arguments) },
      });
    }
    assert.equal(choice.finish_reason, calls.size ? 'tool_calls' : 'stop');
  }
  return { role: 'assistant', content, ...(calls.size ? { tool_calls: [...calls.values()] } : {}) };
}
export async function start(f: HttpFixture, request = initial()): Promise<ChatCompletionRequest> {
  f.transport.plans.push('tool');
  const assistant = completion(await f.request('/v1/chat/completions', request));
  assert.equal(assistant.tool_calls?.length, 1);
  const call = assistant.tool_calls?.[0];
  assert.ok(call);
  assert.equal(call.function.name, 'echo_value');
  assert.deepEqual(JSON.parse(call.function.arguments), { value: 'synthetic-value' });
  return {
    ...request,
    messages: [
      ...request.messages,
      assistant,
      { role: 'tool', tool_call_id: call.id, content: 'synthetic-result' },
    ],
  };
}
