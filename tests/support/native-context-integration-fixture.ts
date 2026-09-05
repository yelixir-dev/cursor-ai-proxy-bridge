import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { awaitWithAbort, CursorAuthProvider } from '../../src/backend/cursor-api/auth.js';
import { CursorApiBackend } from '../../src/backend/cursor-api/backend.js';
import {
  ConnectFrameDecoder,
  encodeConnectFrame,
} from '../../src/backend/cursor-api/connect-frame.js';
import { loadProtoDescriptors, ProtoCodec } from '../../src/backend/cursor-api/protobuf.js';
import type { CursorApiTransport } from '../../src/backend/cursor-api/transport.js';
import type { ChatCompletionRequest } from '../../src/backend/types.js';
import type { BridgeConfig } from '../../src/config.js';
import { ScriptedStream, trailer, update } from './cursor-api-scripted.js';
import { nativeContextResponse, nativePluginRoot } from './native-context-fixture.js';

export const codec = new ProtoCodec(loadProtoDescriptors());
export const account = (id: string) => ({ id, apiKey: id, enabled: true, weight: 1 });
export const config: BridgeConfig = {
  host: '127.0.0.1',
  port: 0,
  backend: 'cursor-api',
  defaultModel: 'composer-2.5',
  workspaceMode: 'chat-only',
  version: 'test',
  cursorApiCredentials: [account('A'), account('B')],
};
export const request: ChatCompletionRequest = {
  model: 'composer-2.5',
  messages: [{ role: 'user', content: 'CONTEXT_OK' }],
};
export const managedPath = join(homedir(), '.cursor/skills-cursor/fixture-A/SKILL.md');
export const pluginPath = join(homedir(), nativePluginRoot, 'skills/demo/pending.md');
export const bounded = <T>(promise: Promise<T>) =>
  awaitWithAbort(promise, AbortSignal.timeout(2_000));
export const cleanup: (() => Promise<void>)[] = [];

export function object(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}
export function decoded(stream: ScriptedStream): Record<string, unknown>[] {
  return new ConnectFrameDecoder()
    .push(Buffer.concat(stream.writes))
    .flatMap((frame) =>
      frame.payload ? [codec.decode('agent.v1.AgentClientMessage', frame.payload)] : [],
    );
}
export function exec(
  stream: ScriptedStream,
  kind: string,
  value: Record<string, unknown>,
  id = 7,
): void {
  stream.emit(
    'data',
    encodeConnectFrame(
      codec.encode('agent.v1.AgentServerMessage', {
        message: {
          case: 'execServerMessage',
          value: { id, execId: 'exec-' + id, message: { case: kind, value } },
        },
      }),
    ),
  );
}
export function reply(stream: ScriptedStream, kind: string) {
  return decoded(stream)
    .map((frame) => object(frame.message))
    .filter((message) => message.case === 'execClientMessage')
    .map((message) => object(message.value))
    .find((value) => object(value.message).case === kind);
}
export function onReply(stream: ScriptedStream, kind: string): Promise<Record<string, unknown>> {
  return bounded(
    new Promise((resolve) => {
      const receive = () => {
        const found = reply(stream, kind);
        if (found) {
          stream.off('write', receive);
          resolve(found);
        }
      };
      stream.on('write', receive);
    }),
  );
}
export function finish(stream: ScriptedStream): void {
  stream.emit(
    'data',
    Buffer.concat([
      update('textDelta', { text: 'CONTEXT_OK' }),
      update('turnEnded', {}),
      trailer(),
    ]),
  );
}
export function fixture() {
  let stopped = false;
  const opened = Promise.withResolvers<ScriptedStream>();
  const calls: { method: string; token: string; bootstrap: boolean; signal?: AbortSignal }[] = [];
  const streams: ScriptedStream[] = [];
  const gates = new Map<string, ReturnType<typeof Promise.withResolvers<Buffer>>>();
  const entered = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
  const fetchStarted = Promise.withResolvers<AbortSignal>();
  const fetchFinished = Promise.withResolvers<Response>();
  const transport: CursorApiTransport = {
    async shutdown() {
      stopped = true;
    },
    async unary(path, _body, signal, bootstrap = false, token = '') {
      const method = path.split('/').at(-1) ?? '';
      calls.push({ method, token, bootstrap, signal });
      entered.get(token + ':' + method)?.resolve();
      const gate = gates.get(token + ':' + method);
      if (gate) return gate.promise;
      if (
        ['GetMe', 'GetManagedSkills', 'GetEffectiveUserPlugins', 'GetServerConfig'].includes(method)
      )
        return nativeContextResponse(path, token, true);
      return Buffer.alloc(0);
    },
    async openRun() {
      const stream = new ScriptedStream((active) => {
        exec(active, 'requestContextArgs', {}, 0);
        opened.resolve(active);
      });
      streams.push(stream);
      return stream;
    },
  };
  const auth = new CursorAuthProvider({
    environment: {},
    fetch: async (_url, init) =>
      new Response(
        JSON.stringify({
          accessToken: new Headers(init?.headers).get('authorization')?.replace('Bearer ', ''),
        }),
      ),
  });
  const dependencies = {
    transport,
    auth,
    environment: { CURSOR_DATA_DIR: '/isolated/context-data' },
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/pending.md')) {
        assert.ok(init?.signal);
        fetchStarted.resolve(init.signal);
        return fetchFinished.promise;
      }
      return new Response(
        String(url).includes('/agents/')
          ? '---\nname: worker\ndescription: Worker\n---\nWORKER_PROMPT'
          : '---\nname: plugin-skill\ndescription: Plugin skill\n---\nPLUGIN_BODY',
      );
    },
  };
  const backend = new CursorApiBackend(config, dependencies);
  cleanup.push(() => backend.shutdown());
  return {
    backend,
    dependencies,
    calls,
    streams,
    opened: opened.promise,
    gates,
    entered,
    fetchStarted,
    fetchFinished,
    transportStopped: () => stopped,
  };
}
