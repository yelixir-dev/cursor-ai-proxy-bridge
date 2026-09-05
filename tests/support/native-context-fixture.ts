import {
  loadNativeAccountContext,
  type NativeContextOptions,
} from '../../src/backend/cursor-api/native-context.js';
import { loadProtoDescriptors, ProtoCodec } from '../../src/backend/cursor-api/protobuf.js';

const codec = new ProtoCodec(loadProtoDescriptors());
export const managedContextBody =
  '---\nname: fixture-skill\ndescription: Fixture skill\n---\nONE\nTWO\nTHREE\n';
export const nativePluginCommit = 'a'.repeat(40);
export const nativePluginRoot =
  '.cursor/plugins/cache/fixture-market/fixture-plugin/' + nativePluginCommit;

/** Explicit isolated account metadata for legacy transport fixtures, never an empty provider. */
export function nativeContextResponse(path: string, account = 'fixture', plugins = false): Buffer {
  const method = path.split('/').at(-1);
  switch (method) {
    case 'GetMe':
      return codec.encode('aiserver.v1.GetMeResponse', { authId: 'auth|' + account });
    case 'GetServerConfig':
      return codec.encode('aiserver.v1.GetServerConfigResponse', {
        agentUrlConfig: { agentnUrl: 'https://agent.test' },
        indexingConfig: {
          defaultUserPathEncryptionKey: Buffer.alloc(32, account === 'B' ? 2 : 1).toString(
            'base64url',
          ),
        },
      });
    case 'GetManagedSkills':
      return codec.encode('aiserver.v1.GetManagedSkillsResponse', {
        skills: [
          {
            id: 'fixture-' + account,
            name: 'fixture-skill',
            enabled: true,
            description: 'Fixture skill',
            content: managedContextBody,
            environments: ['local'],
            resources: { 'empty.md': '' },
          },
        ],
      });
    case 'GetEffectiveUserPlugins':
      return codec.encode(
        'aiserver.v1.GetEffectiveUserPluginsResponse',
        plugins
          ? {
              plugins: [
                {
                  isEnabled: true,
                  plugin: {
                    id: 12,
                    name: 'fixture-plugin',
                    gitUrl: 'https://github.com/example/context.git',
                    gitRef: nativePluginCommit,
                    marketplace: { id: 34, name: 'fixture-market' },
                    skills: [
                      {
                        name: 'plugin-skill',
                        description: 'Plugin skill',
                        sourcePath: 'skills/demo/SKILL.md',
                      },
                    ],
                    subagents: [
                      { name: 'worker', description: 'Worker', sourcePath: 'agents/worker.md' },
                    ],
                  },
                },
              ],
            }
          : {},
      );
    default:
      throw new Error('Unexpected native context fixture RPC: ' + path);
  }
}

export const fixtureNativeContext = (options: Partial<NativeContextOptions> = {}) =>
  loadNativeAccountContext({
    signal: new AbortController().signal,
    fetch: async () => {
      throw new Error('Unexpected fixture context source fetch');
    },
    ...options,
    codec,
    rpc: async (path) => nativeContextResponse(path),
  });
