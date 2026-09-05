import { posix } from 'node:path';
import { z } from 'zod';
import {
  frontmatter,
  githubSource,
  identity,
  metadataOf,
  relativeSourcePath,
  stringList,
  type NativeSourceReader,
} from './native-context-files.js';

const strings = z.array(z.string()).default([]);
const descriptor = z.object({
  name: z.string(),
  description: z.string().default(''),
  sourcePath: z.string(),
  sourceUrl: z.string().default(''),
  environments: strings,
  disabledEnvironments: strings,
});
const id = z
  .union([z.number().int().positive().refine(Number.isSafeInteger), z.bigint().positive()])
  .transform(String);
const marketplace = z.object({ id, name: z.string() });
export const meSchema = z.object({
  authId: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[a-zA-Z0-9_|:-]+$/),
});
export const managedSchema = z.object({
  skills: z
    .array(
      z.object({
        id: z.string(),
        description: z.string().default(''),
        content: z.string().default(''),
        enabled: z.boolean().default(false),
        disableModelInvocation: z.boolean().default(false),
        environments: strings,
        disabledEnvironments: strings,
        resources: z.record(z.string(), z.string()).default({}),
      }),
    )
    .max(512)
    .default([]),
});
export const pluginsSchema = z.object({
  marketplaces: z.array(marketplace).default([]),
  plugins: z
    .array(
      z.object({
        isEnabled: z.boolean().default(false),
        pinnedGitRef: z.string().optional(),
        plugin: z.object({
          id,
          name: z.string(),
          gitUrl: z.string(),
          gitRef: z.string(),
          gitPath: z.string().default(''),
          marketplace: marketplace.optional(),
          marketplaceId: id.optional(),
          skills: z.array(descriptor).max(512).default([]),
          subagents: z.array(descriptor).max(128).default([]),
        }),
      }),
    )
    .max(128)
    .default([]),
});

export interface SkillMetadata {
  readonly description: string;
  readonly environments: readonly string[];
  readonly disabledEnvironments: readonly string[];
  readonly disableModelInvocation?: boolean;
  readonly globs?: readonly string[];
  readonly scopedTo?: readonly string[];
}
export interface PluginIdentity {
  readonly plugin: string;
  readonly marketplace: string;
  readonly pluginId: string;
  readonly marketplaceId: string;
}
export interface ManagedFact {
  readonly id: string;
  readonly metadata: SkillMetadata;
  readonly files: Readonly<Record<string, string>>;
}
export interface PluginFact {
  readonly identity: PluginIdentity;
  readonly commit: string;
  readonly gitPath: string;
  readonly rawSource: (path: string) => string;
  readonly skills: readonly {
    readonly path: string;
    readonly content: string;
    readonly metadata: SkillMetadata;
  }[];
  readonly agents: readonly {
    readonly path: string;
    readonly content: string;
    readonly name: string;
    readonly description: string;
    readonly prompt: string;
    readonly permissionMode: number;
  }[];
}
function local(environments: readonly string[], disabled: readonly string[]): boolean {
  return (!environments.length || environments.includes('local')) && !disabled.includes('local');
}
function fields(
  data: Record<string, unknown>,
  fallback: { environments: string[]; disabledEnvironments: string[] },
) {
  const meta = metadataOf(data);
  return {
    environments:
      data.environments !== undefined || meta.environments !== undefined
        ? stringList(data.environments ?? meta.environments)
        : fallback.environments,
    disabledEnvironments:
      data['disabled-environments'] !== undefined || meta.disabledEnvironments !== undefined
        ? stringList(data['disabled-environments'] ?? meta.disabledEnvironments)
        : fallback.disabledEnvironments,
  };
}
export function managedFacts(input: z.infer<typeof managedSchema>): ManagedFact[] {
  return input.skills
    .flatMap((skill) => {
      identity(skill.id);
      if (
        !skill.enabled ||
        !skill.description.trim() ||
        !local(skill.environments, skill.disabledEnvironments)
      )
        return [];
      const { data } = frontmatter(skill.content);
      const surfaces = stringList(metadataOf(data).surfaces);
      const environments = fields(data, skill);
      if (
        (surfaces.length && !surfaces.includes('cli')) ||
        data.alwaysApply === true ||
        !local(environments.environments, environments.disabledEnvironments)
      )
        return [];
      const description =
        typeof data.description === 'string' ? data.description : skill.description;
      if (!description.trim()) return [];
      if (!skill.content.trim()) throw new Error('Missing managed skill content');
      const files: Record<string, string> = { 'SKILL.md': skill.content };
      for (const [path, text] of Object.entries(skill.resources)) {
        relativeSourcePath(path);
        if (path === 'SKILL.md') throw new Error('Duplicate managed skill path');
        files[path] = text;
      }
      const globs = stringList(data.paths ?? data.globs);
      const scopedTo = stringList(metadataOf(data).scopedTo ?? data['metadata.scopedTo']);
      return [
        {
          id: skill.id,
          files,
          metadata: {
            description: description.slice(0, 1536),
            ...environments,
            ...(data['disable-model-invocation'] === true || skill.disableModelInvocation
              ? { disableModelInvocation: true }
              : {}),
            ...(globs.length ? { globs } : {}),
            ...(scopedTo.length ? { scopedTo } : {}),
          },
        },
      ];
    })
    .sort((a, b) => (a.id + '/SKILL.md').localeCompare(b.id + '/SKILL.md'));
}

export async function pluginFacts(
  input: z.infer<typeof pluginsSchema>,
  reader: NativeSourceReader,
): Promise<PluginFact[]> {
  // Validate every source before issuing any third-party request.
  const validated = input.plugins
    .filter((item) => item.isEnabled)
    .map((item) => {
      const plugin = item.plugin;
      const market =
        plugin.marketplace ?? input.marketplaces.find((entry) => entry.id === plugin.marketplaceId);
      if (!market) throw new Error('Missing native plugin marketplace identity');
      identity(plugin.name);
      identity(market.name);
      const commit = item.pinnedGitRef || plugin.gitRef;
      const source = githubSource(plugin.gitUrl, commit, plugin.gitPath);
      return {
        plugin,
        source,
        commit,
        identity: {
          plugin: plugin.name,
          marketplace: market.name,
          pluginId: plugin.id,
          marketplaceId: market.id,
        },
        skills: plugin.skills.map((skill) => ({
          descriptor: skill,
          path: source.relative(skill.sourcePath, skill.sourceUrl),
        })),
        agents: plugin.subagents.map((agent) => ({
          descriptor: agent,
          path: source.relative(agent.sourcePath, agent.sourceUrl),
        })),
      };
    });
  return Promise.all(
    validated.map(async (item) => {
      const skills = await Promise.all(
        item.skills.map(async ({ path, descriptor }) => {
          if (
            !descriptor.description.trim() ||
            !local(descriptor.environments, descriptor.disabledEnvironments)
          )
            return [];
          const content = await reader.read(item.source.raw(descriptor.sourcePath));
          const { data } = frontmatter(content);
          const environments = fields(data, descriptor);
          if (
            data.alwaysApply === true ||
            !local(environments.environments, environments.disabledEnvironments)
          )
            return [];
          const description =
            typeof data.description === 'string' ? data.description : descriptor.description;
          if (!description.trim()) return [];
          return [
            {
              path,
              content,
              metadata: {
                description: description.slice(0, 1536),
                ...environments,
                ...(data['disable-model-invocation'] === true
                  ? { disableModelInvocation: true }
                  : {}),
              },
            },
          ];
        }),
      );
      const agents = await Promise.all(
        item.agents.map(async ({ path, descriptor }) => {
          const content = await reader.read(item.source.raw(descriptor.sourcePath));
          const { data, body } = frontmatter(content);
          if (!body) throw new Error('Missing native plugin subagent prompt');
          const permission = data.permissionMode ?? data.permissionmode;
          if (permission !== undefined && typeof permission !== 'string')
            throw new Error('Invalid native subagent permission mode');
          const name =
            typeof data.name === 'string'
              ? data.name
              : posix.basename(path, posix.extname(path)).replace(/[\s_]+/g, '-');
          return {
            path,
            content,
            name,
            description: typeof data.description === 'string' ? data.description : '',
            prompt: body,
            permissionMode:
              typeof permission === 'string' && permission.trim().toLowerCase() === 'readonly'
                ? 2
                : 1,
          };
        }),
      );
      return {
        identity: item.identity,
        commit: item.commit,
        gitPath: item.plugin.gitPath,
        rawSource: item.source.raw,
        skills: skills.flat().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
        agents,
      };
    }),
  );
}
