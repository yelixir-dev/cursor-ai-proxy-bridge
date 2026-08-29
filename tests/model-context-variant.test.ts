import { describe, expect, it } from 'vitest';
import { unifiedModelList } from '../src/backend/cursor-api/unified-models.js';
import type { BridgeModel } from '../src/backend/types.js';
import {
  cursorModelContextWindow,
  parseCursorContextParameter,
  withCursorModelContext,
} from '../src/model-context.js';

function slug(id: string): BridgeModel {
  return { id, object: 'model', created: 1_700_000_000, owned_by: 'cursor' };
}

describe('live variant context windows', () => {
  it('parses the Cursor context parameter into a token count', () => {
    // Given/When: the upstream variant parameter values Cursor advertises.
    // Then: only documented magnitudes decode, and unknown shapes stay undefined.
    expect(parseCursorContextParameter('1m')).toBe(1_000_000);
    expect(parseCursorContextParameter('300k')).toBe(300_000);
    expect(parseCursorContextParameter('272k')).toBe(272_000);
    expect(parseCursorContextParameter('200k')).toBe(200_000);
    expect(parseCursorContextParameter('unlimited')).toBeUndefined();
    expect(parseCursorContextParameter('')).toBeUndefined();
  });

  it('advertises the live 1M variant window instead of the static family default', () => {
    // Given: Cursor resolves the fast Opus 5 slug to its 1M max-mode variant.
    const live = new Map([['opus-5-fast', 1_000_000]]);

    // When: the unified list is built with the live resolver.
    const models = unifiedModelList(
      [slug('claude-opus-5-medium-fast'), slug('claude-opus-5-medium')],
      (id) => {
        const contextWindow = live.get(id);
        return contextWindow === undefined
          ? undefined
          : { contextWindow, isMaxMode: contextWindow === 1_000_000 };
      },
    );

    // Then: the fast id reports 1M while the untouched id keeps its documented window.
    expect(models.find((model) => model.id === 'opus-5-fast')).toMatchObject({
      context_window: 1_000_000,
      context_length: 1_000_000,
      max_context_length: 1_000_000,
    });
    expect(models.find((model) => model.id === 'opus-5')?.context_window).toBe(300_000);
  });

  it('falls back to the documented window when upstream exposes no context parameter', () => {
    // Given: a family Cursor advertises without a context variant parameter.
    // When: the resolver returns nothing for it.
    const models = unifiedModelList([slug('composer-2.5')], () => undefined);

    // Then: the curated documented window still reaches OpenAI clients.
    expect(models[0]?.context_window).toBe(200_000);
  });

  it('uses the documented Sonnet 5 default window', () => {
    // Given/When/Then: Cursor serves Sonnet 5 with a 300k default context window.
    expect(cursorModelContextWindow('sonnet-5')).toBe(300_000);
  });

  it('keeps a backend-resolved window when the curated default is re-applied', () => {
    // Given: the cursor-api backend already advertised the live 1M variant.
    const resolved = withCursorModelContext({
      ...slug('opus-5-fast'),
      context_window: 1_000_000,
      context_length: 1_000_000,
      max_context_length: 1_000_000,
    });

    // When/Then: the HTTP layer's curated pass does not shrink it back.
    expect(resolved.context_window).toBe(1_000_000);
  });
});
