import { afterEach, describe, expect, it, vi } from 'vitest';
import { CursorAuthProvider, awaitWithAbort } from '../src/backend/cursor-api/auth.js';
import type { CursorApiCredential } from '../src/backend/cursor-api/credentials.js';
import { CursorApiDiscovery } from '../src/backend/cursor-api/discovery.js';
import { loadProtoDescriptors, ProtoCodec } from '../src/backend/cursor-api/protobuf.js';
import { createCursorApiRuntime } from '../src/backend/cursor-api/runtime.js';
import { CURSOR_API_STARTUP_SEQUENCE } from '../src/backend/cursor-api/startup-sequence.js';
import type { CursorApiTransport } from '../src/backend/cursor-api/transport.js';
import { fixtureNativeContext } from './support/native-context-fixture.js';

const codec = new ProtoCodec(loadProtoDescriptors());
const A: CursorApiCredential = { id: 'A', apiKey: 'key-A', enabled: true, weight: 1 };
const B: CursorApiCredential = { id: 'B', apiKey: 'key-B', enabled: true, weight: 1 };
const bounded = <T>(promise: Promise<T>) => awaitWithAbort(promise, AbortSignal.timeout(1_000));

function catalogue(context = '300k', maxContext = '1m', removed = false) {
  return {
    models: [
      {
        name: 'claude-sonnet-5',
        variants: removed
          ? []
          : [false, true].map((isMaxMode) => ({
              legacySlug: 'claude-sonnet-5-medium',
              isMaxMode,
              parameterValues: [{ id: 'context', value: isMaxMode ? maxContext : context }],
            })),
      },
    ],
  };
}

function fixture(credentials = [A, B]) {
  let now = 10_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const available = new Map([
    ['token-A', catalogue()],
    ['token-B', catalogue('500k', '2m')],
  ]);
  const calls: Array<{ token: string; method: string; bootstrap: boolean }> = [];
  const gates = new Map<string, ReturnType<typeof gate>>();
  function gate() {
    return {
      entered: Promise.withResolvers<void>(),
      response: Promise.withResolvers<void>(),
      finished: Promise.withResolvers<void>(),
    };
  }
  const transport: CursorApiTransport = {
    async unary(path, body, _signal, bootstrap = false, token = '') {
      const method = path.split('/').at(-1) ?? '';
      calls.push({ token, method, bootstrap });
      const pending = gates.get(`${token}:${method}`);
      gates.delete(`${token}:${method}`);
      const source = available.get(token) ?? catalogue();
      try {
        if (pending) {
          pending.entered.resolve();
          await pending.response.promise;
        }
        switch (method) {
          case 'GetMe':
            return codec.encode('aiserver.v1.GetMeResponse');
          case 'GetServerConfig':
            return codec.encode('aiserver.v1.GetServerConfigResponse', {
              agentUrlConfig: { agentnUrl: `https://${token}.test` },
            });
          case 'AvailableModels':
            expect(
              codec.decode('aiserver.v1.AvailableModelsRequest', Buffer.from(body)),
            ).toMatchObject({ useModelParameters: true, doNotUseMarkdown: true });
            return codec.encode('aiserver.v1.AvailableModelsResponse', source);
          case 'GetUsableModels':
            return codec.encode('agent.v1.GetUsableModelsResponse', {
              models: [{ modelId: 'claude-sonnet-5-medium', maxMode: false }],
            });
          case 'GetDefaultModelForCli':
            return codec.encode('agent.v1.GetDefaultModelForCliResponse', {
              model: { modelId: `default-${token}` },
            });
          default:
            throw new Error(`Unexpected discovery method: ${method}`);
        }
      } finally {
        pending?.finished.resolve();
      }
    },
    async telemetry(path, _body, _signal, token = '') {
      calls.push({ token, method: path.split('/').at(-1) ?? '', bootstrap: false });
    },
    async openRun() {
      throw new Error('Discovery must not open a Run');
    },
  };
  const runtime = createCursorApiRuntime(
    {
      host: '127.0.0.1',
      port: 0,
      backend: 'cursor-api',
      defaultModel: 'configured-default',
      workspaceMode: 'chat-only',
      version: 'test',
      cursorApiCredentials: credentials,
    },
    {
      transport,
      environment: {},
      loadNativeContext: fixtureNativeContext,
      auth: new CursorAuthProvider({
        environment: {},
        fetch: async (_url, init) =>
          new Response(
            JSON.stringify({
              accessToken: new Headers(init?.headers)
                .get('authorization')
                ?.replace('Bearer key-', 'token-'),
            }),
          ),
      }),
    },
  );
  return {
    discovery: new CursorApiDiscovery(runtime),
    runtime,
    available,
    calls,
    advance(ms: number) {
      now += ms;
    },
    hold(token: string, method: string) {
      const pending = gate();
      gates.set(`${token}:${method}`, pending);
      return pending;
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe('credential-scoped discovery snapshots', () => {
  it('isolates concurrent A/B endpoints and model variants without rerouting', async () => {
    const f = fixture();
    const aGate = f.hold('token-A', 'AvailableModels');
    const bGate = f.hold('token-B', 'AvailableModels');
    const a = f.discovery.prepare(A, 'token-A');
    const b = f.discovery.prepare(B, 'token-B');
    await bounded(Promise.all([aGate.entered.promise, bGate.entered.promise]));
    bGate.response.resolve();
    const bSnapshot = await bounded(b);
    aGate.response.resolve();
    const aSnapshot = await bounded(a);
    expect(aSnapshot.agentUrl).toBe('https://token-A.test');
    expect(bSnapshot.agentUrl).toBe('https://token-B.test');
    expect(aSnapshot.resolveRequestedModel('sonnet-5')?.parameters).toContainEqual({
      id: 'context',
      value: '300k',
    });
    expect(bSnapshot.resolveRequestedModel('sonnet-5')?.parameters).toContainEqual({
      id: 'context',
      value: '500k',
    });
    expect(f.runtime.credentialRouter.snapshot().map((state) => state.routerPicks)).toEqual([0, 0]);
    expect(f.discovery.cachedModels()).toEqual([]);
  });

  it('shares one endpoint and three-RPC catalogue refresh for the same account', async () => {
    const f = fixture();
    const gate = f.hold('token-A', 'AvailableModels');
    const first = f.discovery.prepare(A, 'token-A');
    await bounded(gate.entered.promise);
    const second = f.discovery.prepare(A, 'token-A');
    gate.response.resolve();
    const snapshots = await bounded(Promise.all([first, second]));
    expect(snapshots.map((snapshot) => snapshot.credentialId)).toEqual(['A', 'A']);
    expect(f.calls.map((call) => call.method).sort()).toEqual([
      'AvailableModels',
      'GetDefaultModelForCli',
      'GetServerConfig',
      'GetUsableModels',
    ]);
  });

  it('refreshes updated and removed variants at model TTL', async () => {
    const f = fixture([A]);
    await f.discovery.listModels();
    f.advance(60_000);
    f.available.set('token-A', catalogue('600k', '2m'));
    const updated = await f.discovery.listModels();
    expect(updated.find((model) => model.id === 'sonnet-5')?.context_window).toBe(600_000);
    f.advance(60_000);
    f.available.set('token-A', catalogue('600k', '2m', true));
    await f.discovery.listModels();
    expect(f.discovery.resolveRequestedModel('sonnet-5')).toBeUndefined();
    expect(f.calls.filter((call) => call.method === 'AvailableModels')).toHaveLength(3);
  });

  it('does not publish partial refreshes or replace listing provenance during inference', async () => {
    const f = fixture([A, B]);
    const listed = await f.discovery.listModels();
    await f.discovery.prepare(B, 'token-B');
    expect(f.discovery.cachedModels()).toEqual(listed);
    f.advance(60_000);
    f.available.set('token-A', catalogue('600k', '2m'));
    const gate = f.hold('token-A', 'GetDefaultModelForCli');
    const failed = f.discovery.prepare(A, 'token-A');
    const assertion = expect(failed).rejects.toThrow('catalogue failure');
    await bounded(gate.entered.promise);
    gate.response.reject(new Error('catalogue failure'));
    await bounded(assertion);
    expect(f.discovery.cachedModels()).toEqual(listed);
    expect(f.discovery.resolveRequestedModel('sonnet-5')?.parameters).toContainEqual({
      id: 'context',
      value: '300k',
    });
    const recovered = await f.discovery.prepare(A, 'token-A');
    expect(recovered.resolveRequestedModel('sonnet-5')?.parameters).toContainEqual({
      id: 'context',
      value: '600k',
    });
  });

  it('rejects invalidated pending waiters promptly and cannot erase a newer refresh', async () => {
    const f = fixture([A]);
    const oldGate = f.hold('token-A', 'AvailableModels');
    const old = f.discovery.prepare(A, 'token-A');
    const rejected = expect(old).rejects.toMatchObject({
      name: 'CursorDiscoveryInvalidatedError',
      credentialId: 'A',
      generation: 0,
    });
    await bounded(oldGate.entered.promise);
    f.discovery.invalidateCredentials(['A']);
    await bounded(rejected);
    f.available.set('token-A', catalogue('700k'));
    const newGate = f.hold('token-A', 'AvailableModels');
    const newer = f.discovery.prepare(A, 'token-A');
    await bounded(newGate.entered.promise);
    oldGate.response.resolve();
    await bounded(oldGate.finished.promise);
    const joined = f.discovery.prepare(A, 'token-A');
    newGate.response.resolve();
    const snapshots = await bounded(Promise.all([newer, joined]));
    expect(snapshots.map((snapshot) => snapshot.generation)).toEqual([1, 1]);
    expect(snapshots[0]?.resolveRequestedModel('sonnet-5')?.parameters).toContainEqual({
      id: 'context',
      value: '700k',
    });
    expect(f.calls.filter((call) => call.method === 'AvailableModels')).toHaveLength(2);
  });

  it('aborts one waiter without killing shared discovery for another', async () => {
    const f = fixture();
    const gate = f.hold('token-A', 'AvailableModels');
    const controller = new AbortController();
    const cancelled = f.discovery.prepare(A, 'token-A', controller.signal);
    const rejected = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    await bounded(gate.entered.promise);
    const survivor = f.discovery.prepare(A, 'token-A');
    controller.abort();
    await bounded(rejected);
    gate.response.resolve();
    expect((await bounded(survivor)).agentUrl).toBe('https://token-A.test');
    expect(f.calls.filter((call) => call.method === 'AvailableModels')).toHaveLength(1);
  });

  it('captures immutable variants and Max Mode policy at preparation entry', async () => {
    const f = fixture();
    const gate = f.hold('token-A', 'AvailableModels');
    const pending = f.discovery.prepare(A, 'token-A');
    await bounded(gate.entered.promise);
    f.discovery.setMaxMode(true);
    gate.response.resolve();
    const standard = await bounded(pending);
    const max = await f.discovery.prepare(A, 'token-A');
    expect(standard.maxModeEnabled).toBe(false);
    expect(standard.resolveVariant('sonnet-5')?.isMaxMode).toBe(false);
    expect(max.resolveRequestedModel('sonnet-5')?.parameters).toContainEqual({
      id: 'context',
      value: '1m',
    });
    const model = standard.resolveRequestedModel('sonnet-5');
    expect(Object.isFrozen(standard)).toBe(true);
    expect(Object.isFrozen(model)).toBe(true);
    expect(Object.isFrozen(model?.parameters)).toBe(true);
    expect(Object.isFrozen(model?.parameters[0])).toBe(true);
  });

  it('preserves startup order, fallback precedence and coherent policy changes', async () => {
    const f = fixture([A]);
    await f.discovery.initialize();
    expect(f.calls.map((call) => call.method)).toEqual(
      CURSOR_API_STARTUP_SEQUENCE.map((path) => path.split('/').at(-1)),
    );
    expect(f.calls.filter((call) => call.bootstrap)).toHaveLength(1);
    f.discovery.setMaxMode(true);
    const models = await f.discovery.listModels();
    expect(models.slice(0, 2).map((model) => model.id)).toEqual([
      'configured-default',
      'default-token-A',
    ]);
    expect(models.find((model) => model.id === 'sonnet-5')).toMatchObject({
      is_max_mode: true,
      context_window: 1_000_000,
    });
    expect(f.discovery.modelVariants(models)).toContainEqual({
      id: 'sonnet-5',
      resolvedVariant: 'claude-sonnet-5-medium',
      isMaxMode: true,
      contextWindow: 1_000_000,
    });
  });

  it('invalidates only the targeted account and rejects removed credential identities', async () => {
    const f = fixture();
    await Promise.all([f.discovery.prepare(A, 'token-A'), f.discovery.prepare(B, 'token-B')]);
    const before = f.calls.length;
    f.discovery.invalidateCredentials(['A']);
    await f.discovery.prepare(B, 'token-B');
    expect(f.calls).toHaveLength(before);
    f.runtime.credentialRouter.replaceCredentials([B]);
    await expect(f.discovery.prepare(A, 'token-A')).rejects.toMatchObject({
      name: 'CursorDiscoveryInvalidatedError',
    });
    expect(f.calls).toHaveLength(before);
  });

  it('does not return an empty success when invalidated during listing route release', async () => {
    const f = fixture([A]);
    const release = f.runtime.credentialRouter.release.bind(f.runtime.credentialRouter);
    vi.spyOn(f.runtime.credentialRouter, 'release').mockImplementation((id) => {
      release(id);
      f.discovery.invalidateCredentials([id]);
    });
    await expect(f.discovery.listModels()).rejects.toMatchObject({
      name: 'CursorDiscoveryInvalidatedError',
      credentialId: 'A',
      generation: 0,
    });
  });

  it('refreshes endpoint TTL independently of catalogue TTL', async () => {
    const f = fixture([A]);
    await f.discovery.prepare(A, 'token-A');
    f.advance(60_000);
    await f.discovery.prepare(A, 'token-A');
    expect(f.calls.filter((call) => call.method === 'GetServerConfig')).toHaveLength(1);
    expect(f.calls.filter((call) => call.method === 'AvailableModels')).toHaveLength(2);
    f.advance(3_540_000);
    await f.discovery.prepare(A, 'token-A');
    expect(f.calls.filter((call) => call.method === 'GetServerConfig')).toHaveLength(2);
  });

  it.each(['AvailableModels', 'GetUsableModels', 'GetDefaultModelForCli'])(
    'propagates initial %s failure instead of advertising fallback-only success',
    async (method) => {
      const f = fixture([A]);
      const gate = f.hold('token-A', method);
      const listing = f.discovery.listModels();
      const failure = new Error('discovery unavailable');
      const rejected = expect(listing).rejects.toBe(failure);
      await bounded(gate.entered.promise);
      gate.response.reject(failure);
      await bounded(rejected);
      expect(f.discovery.cachedModels()).toEqual([]);
      expect(f.discovery.resolveRequestedModel('sonnet-5')).toBeUndefined();
    },
  );

  it('rejects an already aborted waiter without initiating discovery', async () => {
    const f = fixture();
    await expect(f.discovery.prepare(A, 'token-A', AbortSignal.abort())).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(f.calls).toEqual([]);
  });

  it('joins a selected account startup without duplicating its discovery RPCs', async () => {
    const f = fixture([A]);
    const gate = f.hold('token-A', 'AvailableModels');
    const initializing = f.discovery.initialize();
    await bounded(gate.entered.promise);
    const prepared = f.discovery.prepare(A, 'token-A');
    gate.response.resolve();
    await bounded(initializing);
    expect((await bounded(prepared)).agentUrl).toBe('https://token-A.test');
    expect(f.calls.map((call) => call.method)).toEqual(
      CURSOR_API_STARTUP_SEQUENCE.map((path) => path.split('/').at(-1)),
    );
  });
});
