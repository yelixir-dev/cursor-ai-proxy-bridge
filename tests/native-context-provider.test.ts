import { describe, expect, it } from 'vitest';
import {
  loadNativeAccountContext,
  type NativeContextOptions,
} from '../src/backend/cursor-api/native-context.js';
import { loadProtoDescriptors, ProtoCodec } from '../src/backend/cursor-api/protobuf.js';

import { arrayAt, objectAt } from './support/protobuf-values.js';

const codec = new ProtoCodec(loadProtoDescriptors());
const commit = 'a'.repeat(40);
const root = '/isolated/home/.cursor/plugins/cache/test-market/test-plugin/' + commit;
const managedPath = '/isolated/home/.cursor/skills-cursor/rename-chat/SKILL.md';
const paths = {
  homeDir: '/isolated/home',
  dataDir: '/isolated/data',
  workspacePath: '/empty/workspace',
  conversationId: 'conversation-one',
};
const managedBody =
  '---\nname: rename-chat\ndescription: Rename it\ndisable-model-invocation: true\nmetadata:\n  surfaces: [cli]\n---\nMANAGED_BODY\n';
const agentBody =
  '---\nname: Synthetic Agent\ndescription: >-\n  Multi line\n  description\nmodel: sonnet\ntools: [Read, Bash]\npermissionMode: readonly\n---\n  AGENT_PROMPT  \n';
const pluginBody =
  '---\nname: test-skill\ndescription: Skill description\ndisable-model-invocation: true\n---\nPLUGIN_BODY\n';
const sourceUrl = (path: string) =>
  'https://github.com/example/repo/blob/' + commit + '/nested/' + path;
const rawUrl = (path: string) =>
  'https://raw.githubusercontent.com/example/repo/' + commit + '/nested/' + path;

function fixture() {
  const managed: Record<string, unknown>[] = [
    {
      id: 'rename-chat',
      enabled: true,
      description: 'Rename it',
      content: managedBody,
      disableModelInvocation: true,
      environments: ['local'],
    },
    { id: 'canvas', enabled: true, description: '', content: 'body' },
    {
      id: 'ide',
      enabled: true,
      description: 'IDE only',
      content: '---\nmetadata:\n  surfaces: [ide]\n---\nbody',
    },
    { id: 'cloud', enabled: true, description: 'Cloud', content: 'body', environments: ['cloud'] },
    {
      id: 'blocked',
      enabled: true,
      description: 'Blocked',
      content: 'body',
      disabledEnvironments: ['local'],
    },
    { id: 'off', enabled: false, description: 'Off', content: 'body' },
  ];
  const plugin: Record<string, unknown> = {
    id: 9007199254740993n,
    name: 'test-plugin',
    gitUrl: 'https://github.com/example/repo.git',
    gitRef: commit,
    gitPath: 'nested',
    marketplace: { id: 34, name: 'test-market' },
    skills: [
      {
        name: 'test-skill',
        description: 'Skill description',
        sourcePath: 'nested/skills/test-skill/SKILL.md',
        sourceUrl: sourceUrl('skills/test-skill/SKILL.md'),
      },
    ],
    subagents: [
      {
        name: 'metadata-agent',
        description: 'Metadata description',
        sourcePath: 'nested/agents/test.md',
        sourceUrl: sourceUrl('agents/test.md'),
      },
    ],
  };
  const rpcCalls: string[] = [];
  const fetchCalls: { url: string; init: RequestInit | undefined }[] = [];
  const sources = new Map([
    [rawUrl('skills/test-skill/SKILL.md'), pluginBody],
    [rawUrl('agents/test.md'), agentBody],
    [rawUrl('skills/test-skill/references/guide.md'), 'REFERENCE_BODY'],
  ]);
  const controller = new AbortController();
  const options: NativeContextOptions = {
    codec,
    signal: controller.signal,
    rpc: async (path, body) => {
      rpcCalls.push(path);
      const method = path.split('/').at(-1);
      expect(codec.decode('aiserver.v1.' + method + 'Request', body)).toEqual(
        method === 'GetEffectiveUserPlugins' ? { excludeConfiguredVariables: true } : {},
      );
      const data =
        method === 'GetMe'
          ? { authId: 'auth|synthetic-user' }
          : method === 'GetManagedSkills'
            ? { skills: managed }
            : method === 'GetServerConfig'
              ? {
                  indexingConfig: {
                    defaultUserPathEncryptionKey: Buffer.alloc(32, 1).toString('base64url'),
                  },
                }
              : { plugins: [{ isEnabled: true, plugin }] };
      return codec.encode('aiserver.v1.' + method + 'Response', data);
    },
    fetch: async (url, init) => {
      fetchCalls.push({ url: String(url), init });
      const body = sources.get(String(url));
      return new Response(body ?? 'missing', { status: body === undefined ? 404 : 200 });
    },
  };
  return { options, managed, plugin, rpcCalls, fetchCalls, sources, controller };
}

describe('headless native account context', () => {
  it('maps protobuf account facts, native plugin roles and isolated conversation paths', async () => {
    const f = fixture();
    const account = await loadNativeAccountContext(f.options);
    const result = account.forConversation(paths);
    expect(f.rpcCalls.sort()).toEqual(
      [
        ...['GetEffectiveUserPlugins', 'GetManagedSkills', 'GetMe'].map(
          (method) => '/aiserver.v1.DashboardService/' + method,
        ),
        '/aiserver.v1.ServerConfigService/GetServerConfig',
      ].sort(),
    );
    expect(result.context.agentSkills.map((skill) => skill.fullPath)).toEqual([
      managedPath,
      root + '/skills/test-skill/SKILL.md',
    ]);
    expect(result.context.agentSkills[0]).toMatchObject({
      description: 'Rename it',
      environments: ['local'],
      disableModelInvocation: true,
    });
    expect(result.context.agentSkills[1]).toMatchObject({
      disableModelInvocation: true,
      plugin: 'test-plugin',
      marketplace: 'test-market',
      pluginId: '9007199254740993',
      marketplaceId: '34',
      gitRemoteOrigin: 'plugin:test-plugin-' + commit,
    });
    expect(result.context.agentSkills.every((skill) => !('content' in skill))).toBe(true);
    expect(result.context.customSubagents).toEqual([
      {
        fullPath: root + '/agents/test.md',
        name: 'Synthetic Agent',
        description: 'Multi line description',
        tools: [],
        model: 'inherit',
        prompt: 'AGENT_PROMPT',
        permissionMode: 2,
        plugin: 'test-plugin',
        marketplace: 'test-market',
        pluginId: '9007199254740993',
        marketplaceId: '34',
        source: 'plugin',
      },
    ]);
    expect(result.context.env).toEqual({
      projectFolder: '/isolated/data/projects/empty-workspace',
      agentConversationNotesFolder:
        '/isolated/data/projects/empty-workspace/agent-notes/conversation-one',
      agentSharedNotesFolder: '/isolated/data/projects/empty-workspace/agent-notes/shared',
    });
    expect(result.context.hooksConfig).toEqual({});
    expect(Object.isFrozen(account)).toBe(true);
    expect(Object.isFrozen(result.context.agentSkills[0])).toBe(true);
    expect(await result.readFile(managedPath)).toBe(managedBody);
    expect(await result.readFile(root + '/agents/test.md')).toBe(agentBody);
    expect(f.fetchCalls).toHaveLength(2);
    expect(
      f.fetchCalls.every(
        (call) =>
          call.init?.credentials === 'omit' && call.init.redirect === 'error' && !call.init.headers,
      ),
    ).toBe(true);
    expect(result.context.repositoryInfo[0]).toMatchObject({
      relativeWorkspacePath: '.',
      repoOwner: 'auth|synthetic-user',
      orthogonalTransformSeed: 0,
    });
    expect(result.context.repositoryInfo[0]?.repoName).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      Buffer.from(result.context.repositoryInfo[0]?.pathEncryptionKey ?? '', 'base64url'),
    ).toHaveLength(32);
    const next = account.forConversation({ ...paths, conversationId: 'conversation-two' });
    expect(next.context.repositoryInfo).toEqual(result.context.repositoryInfo);
    expect(next.context.env.agentConversationNotesFolder).toBe(
      '/isolated/data/projects/empty-workspace/agent-notes/conversation-two',
    );
  });

  it('retains explicit wire presence and exact selected field numbers', async () => {
    const context = (await loadNativeAccountContext(fixture().options)).forConversation(
      paths,
    ).context;
    const decoded = codec.decode(
      'agent.v1.RequestContext',
      codec.encode('agent.v1.RequestContext', { ...context }),
    );
    expect(decoded).toMatchObject({
      hooksConfig: {},
      commitAttributionMessage: 'enabled',
      prAttributionMessage: 'enabled',
      repositoryInfo: context.repositoryInfo,
    });
    expect(
      arrayAt(decoded.customSubagents).map((value) => {
        const agent = objectAt(value);
        return { ...agent, tools: agent.tools ?? [] };
      }),
    ).toEqual(context.customSubagents);
    expect(Object.hasOwn(decoded, 'conversationNotesListing')).toBe(true);
    expect(Object.hasOwn(decoded, 'sharedNotesListing')).toBe(true);
    expect(decoded.conversationNotesListing).toBe(decoded.sharedNotesListing);
    expect(
      codec.descriptors.messages['agent.v1.RequestContext']?.fields
        .filter((field) => [6, 8, 9, 22, 26, 27, 28, 29].includes(field.no))
        .map((field) => [field.no, field.localName]),
    ).toEqual([
      [6, 'repositoryInfo'],
      [8, 'conversationNotesListing'],
      [9, 'sharedNotesListing'],
      [22, 'customSubagents'],
      [26, 'commitAttributionMessage'],
      [27, 'prAttributionMessage'],
      [28, 'hooksConfig'],
      [29, 'agentSkills'],
    ]);
    expect(codec.descriptors.messages['agent.v1.McpMetaToolOptions']).toBeDefined();
    for (const descriptor of Object.values(codec.descriptors.messages))
      expect(descriptor.fields.map((field) => field.no)).toEqual(
        descriptor.fields.map((field) => field.no).sort((a, b) => a - b),
      );
  });

  it('lazily reads confined plugin sources without consulting the local filesystem', async () => {
    const f = fixture();
    const result = (await loadNativeAccountContext(f.options)).forConversation(paths);
    const reference = root + '/skills/test-skill/references/guide.md';
    expect(f.fetchCalls).toHaveLength(2);
    expect(result.declaredFiles).toContain(managedPath);
    expect(result.declaredFiles).not.toContain(reference);
    expect(result.ownsPath(reference)).toBe(true);
    expect(await result.readFile(reference)).toBe('REFERENCE_BODY');
    expect(await result.readFile(reference)).toBe('REFERENCE_BODY');
    expect(f.fetchCalls).toHaveLength(3);
    expect(await result.readFile('/etc/passwd')).toBeUndefined();
    expect(await result.readFile(root + '-other/secret')).toBeUndefined();
    for (const traversal of ['/../secret', '/%2e%2e/secret', '/a/../../secret', '/a\\..\\secret'])
      await expect(result.readFile(root + traversal)).rejects.toThrow(/path/i);
    expect(f.fetchCalls).toHaveLength(3);
  });

  it.each(['../escape', '/absolute', 'bad/name', 'bad\\name'])(
    'rejects malformed managed identity %s',
    async (id) => {
      const f = fixture();
      f.managed[0] = { ...f.managed[0], id };
      await expect(loadNativeAccountContext(f.options)).rejects.toThrow(/identity/i);
    },
  );
  it.each([
    'nested/../secret',
    '../secret',
    'nested-other/skills/a.md',
    '/nested/skills/a.md',
    'nested/%2e%2e/secret',
  ])('rejects metadata source escape %s', async (sourcePath) => {
    const f = fixture();
    f.plugin.skills = [
      { name: 'bad', description: 'bad', sourcePath, sourceUrl: sourceUrl('skills/bad.md') },
    ];
    await expect(loadNativeAccountContext(f.options)).rejects.toThrow(/path/i);
  });
  it('rejects third-party credentials, cross-repository sources and unpinned refs', async () => {
    for (const gitUrl of [
      'https://token@github.com/example/repo',
      'http://github.com/example/repo',
      'https://127.0.0.1/repo',
    ]) {
      const f = fixture();
      f.plugin.gitUrl = gitUrl;
      await expect(loadNativeAccountContext(f.options)).rejects.toThrow(/source/i);
      expect(f.fetchCalls).toHaveLength(0);
    }
    const f = fixture();
    f.plugin.gitRef = 'main';
    await expect(loadNativeAccountContext(f.options)).rejects.toThrow(/commit/i);
    const g = fixture();
    g.plugin.skills = [
      {
        name: 'bad',
        description: 'bad',
        sourcePath: 'nested/skills/bad.md',
        sourceUrl: 'https://github.com/attacker/repo/blob/' + commit + '/nested/skills/bad.md',
      },
    ];
    await expect(loadNativeAccountContext(g.options)).rejects.toThrow(/source/i);
  });
  it('fails required RPC and markdown metadata rather than returning empty success', async () => {
    const f = fixture();
    f.options.rpc = async () => {
      throw new Error('metadata unavailable');
    };
    await expect(loadNativeAccountContext(f.options)).rejects.toThrow('metadata unavailable');
    const g = fixture();
    g.sources.delete(rawUrl('agents/test.md'));
    await expect(loadNativeAccountContext(g.options)).rejects.toThrow(/404/);
    const h = fixture();
    h.sources.set(rawUrl('agents/test.md'), '---\nname: [invalid\n---\nbody');
    await expect(loadNativeAccountContext(h.options)).rejects.toThrow(/frontmatter/i);
  });
  it('rejects missing account identity and unavailable descriptors', async () => {
    const f = fixture();
    const rpc = f.options.rpc;
    f.options.rpc = (path, body, signal) =>
      path.endsWith('/GetMe') ? Promise.resolve(Buffer.alloc(0)) : rpc(path, body, signal);
    await expect(loadNativeAccountContext(f.options)).rejects.toThrow(/identity/i);
    const g = fixture();
    g.options.codec = new ProtoCodec({ ...codec.descriptors, messages: {} });
    await expect(loadNativeAccountContext(g.options)).rejects.toThrow(/descriptor/i);
    expect(g.rpcCalls).toHaveLength(0);
  });
  it('bounds source size and propagates lazy read failure', async () => {
    const f = fixture();
    f.options.maxSourceBytes = 20;
    await expect(loadNativeAccountContext(f.options)).rejects.toThrow(/limit/i);
    const g = fixture();
    const result = (await loadNativeAccountContext(g.options)).forConversation(paths);
    await expect(result.readFile(root + '/missing.md')).rejects.toThrow(/404/);
  });
  it('observes abort before RPC and during pending source reads without timing sleeps', async () => {
    const f = fixture();
    f.controller.abort(new Error('cancelled-before'));
    await expect(loadNativeAccountContext(f.options)).rejects.toThrow('cancelled-before');
    expect(f.rpcCalls).toHaveLength(0);
    const g = fixture();
    const started = Promise.withResolvers<void>();
    const original = g.options.fetch;
    g.options.fetch = async (url, init) => {
      if (String(url).endsWith('/pending.md')) {
        started.resolve();
        return new Promise<Response>(() => {});
      }
      return original(url, init);
    };
    const result = (await loadNativeAccountContext(g.options)).forConversation(paths);
    const controller = new AbortController();
    const pending = result.readFile(root + '/pending.md', controller.signal);
    const assertion = expect(pending).rejects.toThrow('cancelled-read');
    await started.promise;
    controller.abort(new Error('cancelled-read'));
    await assertion;
    g.controller.abort(new Error('invalidated-generation'));
    await expect(result.readFile(managedPath)).rejects.toThrow('invalidated-generation');
  });
  it('rejects unsafe conversation paths and separates workspace identities', async () => {
    const account = await loadNativeAccountContext(fixture().options);
    expect(() => account.forConversation({ ...paths, conversationId: '../escape' })).toThrow(
      /identity/i,
    );
    expect(() => account.forConversation({ ...paths, homeDir: 'relative' })).toThrow(/absolute/i);
    expect(
      account.forConversation({ ...paths, workspacePath: '/another/workspace' }).context
        .repositoryInfo[0]?.repoName,
    ).not.toBe(account.forConversation(paths).context.repositoryInfo[0]?.repoName);
  });
});
