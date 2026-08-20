import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createCanonicalCases } from '../src/benchmark/cases.js';
import { providerDefinition } from '../src/benchmark/fixture-provider.js';

const composerMetadataSchema = z.object({
  providers: z.object({
    yorha: z.object({
      models: z.tuple([
        z.object({
          id: z.string(),
          upstreamModelId: z.string(),
          reasoning: z.boolean(),
          input: z.tuple([z.string()]),
          cost: z.object({
            input: z.number(),
            output: z.number(),
            cacheRead: z.number(),
            cacheWrite: z.number(),
          }),
          contextWindow: z.number(),
          maxTokens: z.number(),
        }),
      ]),
    }),
  }),
});

describe('benchmark Composer provider metadata', () => {
  it('omits parallel scheduling in the two-call comparator case', () => {
    // Given the canonical benchmark case set
    const testCase = createCanonicalCases().find(
      (candidate) => candidate.id === 'tool_parallel_two',
    );

    // When the two-call request metadata is inspected
    const parallelToolCalls = testCase?.request.parallelToolCalls;

    // Then scheduling remains delegated to the compared model
    expect(parallelToolCalls).toBeNull();
  });

  it('emits native comparator fields when generating the yorha definition', () => {
    // Given a local bridge endpoint
    const endpoint = 'http://127.0.0.1:9997/v1';

    // When the temporary OMO provider is generated
    const { models } = composerMetadataSchema.parse(JSON.parse(providerDefinition(endpoint)))
      .providers.yorha;

    // Then its machine-consumed Composer metadata matches the native comparator
    expect(models[0]).toEqual({
      id: 'composer-2.5',
      upstreamModelId: 'composer-2.5',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 64_000,
    });
  });
});
