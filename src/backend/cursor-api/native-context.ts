import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { awaitWithAbort } from './auth.js';
import {
  absoluteContextPath,
  freeze,
  hasControlCharacters,
  identity,
  NativeSourceReader,
  relativeSourcePath,
  type SourceReaderOptions,
} from './native-context-files.js';
import {
  managedFacts,
  managedSchema,
  meSchema,
  pluginFacts,
  pluginsSchema,
  type PluginIdentity,
  type SkillMetadata,
} from './native-context-metadata.js';
import type { ProtoCodec } from './protobuf.js';
import {
  assertNativeRepositoryDescriptors,
  nativeRepositoryEncryptionKey,
  nativeRepositoryStateId,
  type NativeRepositoryState,
} from './native-context-repository.js';

export type { NativeRepositoryState } from './native-context-repository.js';

export interface NativeContextOptions extends SourceReaderOptions {
  codec: ProtoCodec;
  /** Selected-credential unary RPC closure. Must retain native CLI transport headers. */
  rpc(path: string, body: Uint8Array, signal: AbortSignal): Promise<Uint8Array>;
}
export interface NativeConversationPaths {
  homeDir: string;
  dataDir?: string;
  workspacePath: string;
  conversationId: string;
  /** Optional native repo.json snapshot. Absent for a fresh isolated profile. No disk I/O. */
  repositoryState?: NativeRepositoryState;
}
export interface NativeRepositoryInfo {
  readonly relativeWorkspacePath: '.';
  readonly repoName: string;
  readonly repoOwner: string;
  readonly orthogonalTransformSeed: 0;
  readonly pathEncryptionKey: string;
}
export interface NativeContextSkill extends SkillMetadata, Partial<PluginIdentity> {
  readonly fullPath: string;
  readonly gitRemoteOrigin?: string;
}
export interface NativeContextSubagent extends PluginIdentity {
  readonly fullPath: string;
  readonly name: string;
  readonly description: string;
  readonly tools: readonly string[];
  readonly model: 'inherit';
  readonly prompt: string;
  readonly permissionMode: number;
  readonly source: 'plugin';
}
export interface NativeContextPatch {
  readonly repositoryInfo: readonly NativeRepositoryInfo[];
  readonly conversationNotesListing: string;
  readonly sharedNotesListing: string;
  readonly commitAttributionMessage: 'enabled';
  readonly prAttributionMessage: 'enabled';
  readonly hooksConfig: Readonly<Record<string, never>>;
  readonly agentSkills: readonly NativeContextSkill[];
  readonly customSubagents: readonly NativeContextSubagent[];
  readonly env: Readonly<{
    projectFolder: string;
    agentConversationNotesFolder: string;
    agentSharedNotesFolder: string;
  }>;
}
export interface NativeConversationContext {
  readonly context: NativeContextPatch;
  readonly declaredFiles: readonly string[];
  /** Invalid paths throw; unrelated paths return false, never touch local disk. */
  ownsPath(path: string): boolean;
  /** Full UTF-8 contents. Caller applies native ReadArgs line slicing/result encoding. */
  readFile(path: string, signal?: AbortSignal): Promise<string | undefined>;
}
export interface NativeAccountContext {
  /** No auth selection or refresh here: caller retains this object only for its credential generation. */
  forConversation(paths: NativeConversationPaths): NativeConversationContext;
}

const EMPTY_NOTES = '(No notes directory yet - will be created when you write your first note)';
const METHODS = [
  'GetMe',
  'GetManagedSkills',
  'GetEffectiveUserPlugins',
  'GetServerConfig',
] as const;

/**
 * Headless, fresh empty-workspace profile only. Never reads/writes HOME, installs plugins,
 * executes plugin code/hooks, or discovers unrelated user-local configuration.
 *
 * Merge context into RequestContext with a nested env merge; retain readFile beside that
 * conversation and consult ownsPath before routing native readArgs to external tools.
 * Plugin declared markdown is fetched to recover flags/prompts absent from API metadata;
 * additional source files are bounded lazy reads from the same pinned repository subtree.
 */
export async function loadNativeAccountContext(
  options: NativeContextOptions,
): Promise<NativeAccountContext> {
  options.signal.throwIfAborted();
  for (const type of [
    ...METHODS.flatMap((method) => [
      'aiserver.v1.' + method + 'Request',
      'aiserver.v1.' + method + 'Response',
    ]),
    'agent.v1.AgentSkill',
    'agent.v1.CustomSubagent',
    'agent.v1.RepositoryIndexingInfo',
  ]) {
    if (!options.codec.descriptors.messages[type])
      throw new Error('Missing native context protobuf descriptor: ' + type);
  }
  assertNativeRepositoryDescriptors(options.codec);
  const reader = new NativeSourceReader({ ...options });
  const responses = await Promise.all(
    METHODS.map(async (method) => {
      const body = options.codec.encode(
        'aiserver.v1.' + method + 'Request',
        method === 'GetEffectiveUserPlugins' ? { excludeConfiguredVariables: true } : {},
      );
      const service = method === 'GetServerConfig' ? 'ServerConfigService' : 'DashboardService';
      const bytes = await awaitWithAbort(
        options.rpc('/aiserver.v1.' + service + '/' + method, body, options.signal),
        options.signal,
      );
      if (bytes.byteLength > 16_777_216)
        throw new Error('Native account metadata byte limit exceeded');
      return options.codec.decode('aiserver.v1.' + method + 'Response', bytes);
    }),
  );
  const me = meSchema.safeParse(responses[0]);
  if (!me.success) throw new Error('Invalid native account identity');
  const managedInput = managedSchema.safeParse(responses[1]);
  const pluginsInput = pluginsSchema.safeParse(responses[2]);
  if (!managedInput.success || !pluginsInput.success)
    throw new Error('Invalid native account metadata');
  const pathEncryptionKey = nativeRepositoryEncryptionKey(responses[3]);
  const managed = freeze(managedFacts(managedInput.data));
  const plugins = freeze(await pluginFacts(pluginsInput.data, reader));
  options.signal.throwIfAborted();
  const repositories = new Map<string, NativeRepositoryInfo>();
  return Object.freeze({
    forConversation(paths: NativeConversationPaths): NativeConversationContext {
      options.signal.throwIfAborted();
      const home = absoluteContextPath(paths.homeDir);
      const data = absoluteContextPath(paths.dataDir ?? posix.join(home, '.cursor'));
      const workspace = absoluteContextPath(paths.workspacePath);
      identity(paths.conversationId);
      const projectName = workspace.replace(/^\/+/, '').replace(/[^a-zA-Z0-9]+/g, '-');
      const projectFolder = posix.join(data, 'projects', projectName);
      const repositoryKey = JSON.stringify([home, data, workspace]);
      const persistedRepoName =
        paths.repositoryState === undefined
          ? undefined
          : nativeRepositoryStateId(paths.repositoryState);
      let repository = repositories.get(repositoryKey);
      if (
        repository &&
        persistedRepoName !== undefined &&
        repository.repoName !== persistedRepoName
      ) {
        throw new Error('Native repository identity changed within the same profile');
      }
      if (!repository) {
        repository = freeze({
          relativeWorkspacePath: '.',
          // Native loadRepositoryIdentity reuses repo.json.id, creating a UUID only when
          // absent. Keep that fresh-profile state in memory; the caller owns persistence.
          repoName: persistedRepoName ?? randomUUID(),
          repoOwner: me.data.authId,
          orthogonalTransformSeed: 0,
          pathEncryptionKey,
        });
        repositories.set(repositoryKey, repository);
      }
      const files = new Map<string, string>();
      const skills: NativeContextSkill[] = [];
      const agents: NativeContextSubagent[] = [];
      const lazyRoots: { path: string; raw: (path: string) => string; gitPath: string }[] = [];
      const add = (path: string, content: string) => {
        if (files.has(path)) throw new Error('Duplicate native context file path');
        files.set(path, content);
      };
      for (const skill of managed) {
        const root = posix.join(home, '.cursor', 'skills-cursor', skill.id);
        for (const [path, content] of Object.entries(skill.files))
          add(posix.join(root, path), content);
        skills.push({ fullPath: posix.join(root, 'SKILL.md'), ...skill.metadata });
      }
      for (const plugin of plugins) {
        const root = posix.join(
          home,
          '.cursor',
          'plugins',
          'cache',
          plugin.identity.marketplace,
          plugin.identity.plugin,
          plugin.commit,
        );
        lazyRoots.push({ path: root, raw: plugin.rawSource, gitPath: plugin.gitPath });
        for (const skill of plugin.skills) {
          const fullPath = posix.join(root, skill.path);
          add(fullPath, skill.content);
          skills.push({
            fullPath,
            ...skill.metadata,
            ...plugin.identity,
            gitRemoteOrigin: 'plugin:' + plugin.identity.plugin + '-' + plugin.commit,
          });
        }
        for (const agent of plugin.agents) {
          const fullPath = posix.join(root, agent.path);
          add(fullPath, agent.content);
          // CLI intentionally strips plugin models and tools, unlike workspace subagents.
          agents.push({
            fullPath,
            name: agent.name,
            description: agent.description,
            prompt: agent.prompt,
            permissionMode: agent.permissionMode,
            tools: [],
            model: 'inherit',
            ...plugin.identity,
            source: 'plugin',
          });
        }
      }
      const context: NativeContextPatch = freeze({
        repositoryInfo: [repository],
        conversationNotesListing: EMPTY_NOTES,
        sharedNotesListing: EMPTY_NOTES,
        commitAttributionMessage: 'enabled',
        prAttributionMessage: 'enabled',
        hooksConfig: {},
        agentSkills: skills,
        customSubagents: agents,
        env: {
          projectFolder,
          agentConversationNotesFolder: posix.join(
            projectFolder,
            'agent-notes',
            paths.conversationId,
          ),
          agentSharedNotesFolder: posix.join(projectFolder, 'agent-notes', 'shared'),
        },
      });
      const locate = (path: string) => {
        // Reject traversal before normalization, even if its normalized target is unrelated.
        if (
          !posix.isAbsolute(path) ||
          /[\\%]/.test(path) ||
          hasControlCharacters(path) ||
          path.split('/').some((part) => part === '.' || part === '..')
        )
          throw new Error('Invalid native read path');
        return lazyRoots.find((root) => path.startsWith(root.path + '/'));
      };
      return Object.freeze({
        context,
        declaredFiles: Object.freeze([...files.keys()]),
        ownsPath(path: string) {
          const root = locate(path);
          return files.has(path) || root !== undefined;
        },
        async readFile(path: string, signal?: AbortSignal) {
          options.signal.throwIfAborted();
          signal?.throwIfAborted();
          const root = locate(path);
          const contents = files.get(path);
          if (contents !== undefined) return contents;
          if (!root) return undefined;
          const relative = relativeSourcePath(path.slice(root.path.length + 1));
          return reader.read(
            root.raw(root.gitPath ? root.gitPath + '/' + relative : relative),
            signal,
          );
        },
      });
    },
  });
}
