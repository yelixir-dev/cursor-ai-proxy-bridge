import { describe, expect, it } from 'vitest';
import {
  loadNativeAccountContext,
  type NativeContextOptions,
} from '../src/backend/cursor-api/native-context.js';
import { loadProtoDescriptors, ProtoCodec } from '../src/backend/cursor-api/protobuf.js';

const codec = new ProtoCodec(loadProtoDescriptors());
const userKey = Buffer.alloc(32, 1).toString('base64url');
const teamKey = Buffer.alloc(32, 2).toString('base64url');
const paths = {
  homeDir: '/isolated/home',
  dataDir: '/isolated/data',
  workspacePath: '/isolated/empty',
  conversationId: 'first',
};

// Native wire numbers, independent of the selected descriptor that originally masked these.
function field(number: number, bytes: Uint8Array): Buffer {
  if (bytes.byteLength >= 128) throw new Error('Fixture exceeds single-byte length');
  return Buffer.concat([Buffer.from([(number << 3) | 2, bytes.byteLength]), bytes]);
}
function response(config?: { user?: string; team?: string }): Buffer {
  return config === undefined
    ? Buffer.alloc(0)
    : field(
        3,
        Buffer.concat([
          ...(config.user === undefined ? [] : [field(9, Buffer.from(config.user))]),
          ...(config.team === undefined ? [] : [field(10, Buffer.from(config.team))]),
        ]),
      );
}
function fixture(config = response({ user: userKey })) {
  const calls: string[] = [];
  const options: NativeContextOptions = {
    codec,
    signal: AbortSignal.timeout(5_000),
    rpc: async (path, body) => {
      calls.push(path);
      if (path.endsWith('/GetServerConfig')) {
        expect(path).toBe('/aiserver.v1.ServerConfigService/GetServerConfig');
        expect(Buffer.from(body)).toEqual(Buffer.alloc(0));
        return config;
      }
      return path.endsWith('/GetMe')
        ? codec.encode('aiserver.v1.GetMeResponse', { authId: 'auth|repository-fixture' })
        : Buffer.alloc(0);
    },
    fetch: async () => {
      throw new Error('No source fetch expected');
    },
  };
  return { options, calls };
}

describe('native repository identity source semantics', () => {
  it.each([{ user: userKey, team: teamKey }, { team: teamKey }])(
    'uses the exact server team key when present',
    async (config) => {
      const f = fixture(response(config));
      const account = await loadNativeAccountContext(f.options);
      expect(account.forConversation(paths).context.repositoryInfo[0]?.pathEncryptionKey).toBe(
        teamKey,
      );
      expect(f.calls.filter((path) => path.endsWith('/GetServerConfig'))).toEqual([
        '/aiserver.v1.ServerConfigService/GetServerConfig',
      ]);
    },
  );

  it('falls back to the user key only when the optional team key is absent', async () => {
    const f = fixture();
    const account = await loadNativeAccountContext(f.options);
    expect(account.forConversation(paths).context.repositoryInfo[0]?.pathEncryptionKey).toBe(
      userKey,
    );
    expect(
      codec.decode('aiserver.v1.GetServerConfigResponse', response({ user: userKey })),
    ).toEqual({ indexingConfig: { defaultUserPathEncryptionKey: userKey } });
  });

  it.each([undefined, {}, { user: userKey, team: '' }, { user: 'malformed-key' }])(
    'rejects missing or malformed key configuration without a random fallback',
    async (config) => {
      const f = fixture(response(config));
      await expect(loadNativeAccountContext(f.options)).rejects.toThrow(
        /repository encryption key/i,
      );
    },
  );

  it('propagates a failed required config RPC and never turns it into an empty context', async () => {
    const f = fixture();
    const rpc = f.options.rpc;
    f.options.rpc = (path, body, signal) => {
      if (path.endsWith('/GetServerConfig')) throw new Error('config unavailable');
      return rpc(path, body, signal);
    };
    await expect(loadNativeAccountContext(f.options)).rejects.toThrow('config unavailable');
  });

  it('preserves the same account key across isolated HOME profiles and fresh providers', async () => {
    const one = await loadNativeAccountContext(fixture().options);
    const two = await loadNativeAccountContext(fixture().options);
    const contexts = [
      one.forConversation(paths),
      one.forConversation({ ...paths, homeDir: '/other/home' }),
      two.forConversation(paths),
    ];
    expect(contexts.map((item) => item.context.repositoryInfo[0]?.pathEncryptionKey)).toEqual([
      userKey,
      userKey,
      userKey,
    ]);
    for (const item of contexts) {
      expect(item.context.repositoryInfo[0]).toMatchObject({
        relativeWorkspacePath: '.',
        orthogonalTransformSeed: 0,
      });
      expect(item.context.repositoryInfo[0]?.repoName).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
    expect(
      one.forConversation({ ...paths, conversationId: 'second' }).context.repositoryInfo[0]
        ?.repoName,
    ).toBe(contexts[0]?.context.repositoryInfo[0]?.repoName);
  });

  it('uses the caller-supplied native repo.json id across account generations without profile writes', async () => {
    const repositoryState = Object.freeze({ id: 'f643987d-d78f-4b53-a578-f4c32d0c1cc0' });
    const suppliedPaths = { ...paths, repositoryState };
    for (const account of [
      await loadNativeAccountContext(fixture().options),
      await loadNativeAccountContext(fixture().options),
    ]) {
      expect(account.forConversation(suppliedPaths).context.repositoryInfo[0]?.repoName).toBe(
        repositoryState.id,
      );
    }
    const account = await loadNativeAccountContext(fixture().options);
    expect(() =>
      account.forConversation({ ...paths, repositoryState: { id: '../escape' } }),
    ).toThrow(/repository identity/i);
  });

  it('rejects a codec that still masks the required indexing fields', async () => {
    const f = fixture();
    f.options.codec = new ProtoCodec({
      ...codec.descriptors,
      messages: {
        ...codec.descriptors.messages,
        'aiserver.v1.GetServerConfigResponse': { fields: [] },
      },
    });
    await expect(loadNativeAccountContext(f.options)).rejects.toThrow(/descriptor/i);
    expect(f.calls).toHaveLength(0);
  });
});
