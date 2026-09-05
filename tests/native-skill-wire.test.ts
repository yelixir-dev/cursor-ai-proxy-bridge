import { describe, expect, it } from 'vitest';
import { NativeSourceReader } from '../src/backend/cursor-api/native-context-files.js';
import {
  managedFacts,
  managedSchema,
  pluginFacts,
  pluginsSchema,
} from '../src/backend/cursor-api/native-context-metadata.js';

describe('native skill wire presence and ordering', () => {
  it('orders managed entries by full file path and omits false invocation flags', () => {
    const facts = managedFacts(
      managedSchema.parse({
        skills: ['review', 'review-bugbot', 'review-security'].map((id) => ({
          id,
          enabled: true,
          description: id,
          content: '---\ndescription: ' + id + '\n---\nBODY',
          disableModelInvocation: id === 'review',
        })),
      }),
    );
    expect(facts.map((fact) => fact.id)).toEqual(['review-bugbot', 'review-security', 'review']);
    expect(facts.map((fact) => Object.hasOwn(fact.metadata, 'disableModelInvocation'))).toEqual([
      false,
      false,
      true,
    ]);
    expect(facts[2]?.metadata.disableModelInvocation).toBe(true);
  });

  it('omits a false plugin invocation flag instead of emitting an explicit wire default', async () => {
    const reader = new NativeSourceReader({
      signal: AbortSignal.timeout(5000),
      fetch: async () => new Response('---\ndescription: Example\n---\nBODY'),
    });
    const facts = await pluginFacts(
      pluginsSchema.parse({
        plugins: [
          {
            isEnabled: true,
            plugin: {
              id: 1,
              name: 'example',
              gitUrl: 'https://github.com/example/repo.git',
              gitRef: 'a'.repeat(40),
              marketplace: { id: 2, name: 'market' },
              skills: [
                { name: 'example', description: 'Example', sourcePath: 'skills/example/SKILL.md' },
              ],
            },
          },
        ],
      }),
      reader,
    );
    const skill = facts[0]?.skills[0];
    expect(skill).toBeDefined();
    expect(Object.hasOwn(skill?.metadata ?? {}, 'disableModelInvocation')).toBe(false);
  });
});
