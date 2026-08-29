import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveModelVariant } from '../src/backend/cursor-api/max-mode-policy.js';
import {
  mapMaxModeModels,
  mapRequestedModels,
  type RequestedModelMap,
} from '../src/backend/cursor-api/requested-models.js';
import { loadConfig } from '../src/config.js';

afterEach(() => vi.unstubAllEnvs());

function isolatedEnv(): void {
  vi.stubEnv('CURSOR_BRIDGE_API_KEY', undefined);
  vi.stubEnv('CURSOR_BRIDGE_AUTH', undefined);
  vi.stubEnv('CURSOR_BRIDGE_MAX_MODE_DEFAULT', undefined);
  vi.stubEnv('CURSOR_BRIDGE_DASHBOARD_CONFIG', join(tmpdir(), 'missing-cursor-dashboard.json'));
}

function variant(legacySlug: string, isMaxMode: boolean, context: string, effort: string) {
  return {
    legacySlug,
    variantStringRepresentation: `${legacySlug.replace(/-(low|medium|high|max)$/u, '')}[context=${context},effort=${effort}]`,
    isMaxMode,
    parameterValues: [
      { id: 'context', value: context },
      { id: 'effort', value: effort },
    ],
  };
}

/** Cursor publishes each parameterized slug twice: standard and max-mode. */
const availableModels = {
  models: [
    {
      name: 'claude-sonnet-5',
      variants: [
        variant('claude-sonnet-5-medium', false, '300k', 'medium'),
        variant('claude-sonnet-5-medium', true, '1m', 'medium'),
        variant('claude-sonnet-5-max', false, '300k', 'max'),
        variant('claude-sonnet-5-max', true, '1m', 'max'),
      ],
    },
    {
      name: 'kimi-k3',
      variants: [
        {
          legacySlug: 'kimi-k3-high',
          variantStringRepresentation: 'kimi-k3[reasoning=high]',
          isMaxMode: false,
          parameterValues: [{ id: 'reasoning', value: 'high' }],
        },
      ],
    },
  ],
};

const usableModels = {
  models: [
    { modelId: 'claude-sonnet-5-medium', maxMode: false },
    { modelId: 'claude-sonnet-5-max', maxMode: false },
    { modelId: 'kimi-k3-high', maxMode: false },
  ],
};

function maps(): { standard: RequestedModelMap; max: RequestedModelMap } {
  return {
    standard: mapRequestedModels(availableModels, usableModels),
    max: mapMaxModeModels(availableModels),
  };
}

describe('explicit Max Mode selection policy', () => {
  it('collects only the max-mode variants under their published aliases', () => {
    // Given/When: the upstream catalogue is split into its max-mode half.
    const max = mapMaxModeModels(availableModels);

    // Then: every entry is a max variant, and non-max families stay absent.
    expect([...max.values()].every((model) => model.maxMode)).toBe(true);
    expect(max.get('claude-sonnet-5-medium')?.parameters).toContainEqual({
      id: 'context',
      value: '1m',
    });
    expect(max.has('kimi-k3-high')).toBe(false);
  });

  it('selects the max variant only when the policy is enabled', () => {
    // Given: a family Cursor publishes as both a standard and a max variant.
    const models = maps();

    // When: the same advertised id is resolved under each policy.
    const off = resolveModelVariant(models, { model: 'sonnet-5', maxMode: false });
    const on = resolveModelVariant(models, { model: 'sonnet-5', maxMode: true });

    // Then: only the enabled policy reaches the 1M max-mode variant.
    expect(off?.isMaxMode).toBe(false);
    expect(off?.model.parameters).toContainEqual({ id: 'context', value: '300k' });
    expect(on?.isMaxMode).toBe(true);
    expect(on?.model.parameters).toContainEqual({ id: 'context', value: '1m' });
    expect(on?.slug).toBe('claude-sonnet-5-medium');
  });

  it('falls back to the standard variant when no max variant exists', () => {
    // Given: Cursor publishes Kimi K3 without any max-mode variant.
    const models = maps();

    // When: the policy is enabled anyway.
    const resolved = resolveModelVariant(models, { model: 'kimi-k3', maxMode: true });

    // Then: the request still resolves, on the standard variant.
    expect(resolved?.slug).toBe('kimi-k3-high');
    expect(resolved?.isMaxMode).toBe(false);
  });

  it('keeps reasoning_effort=max distinct from max-mode selection', () => {
    // Given: a request asking for the strongest reasoning effort.
    const models = maps();

    // When: the max-mode policy stays disabled.
    const resolved = resolveModelVariant(models, {
      model: 'sonnet-5',
      effort: 'max',
      maxMode: false,
    });

    // Then: the effort parameter moves but the variant stays standard.
    expect(resolved?.slug).toBe('claude-sonnet-5-max');
    expect(resolved?.isMaxMode).toBe(false);
    expect(resolved?.model.parameters).toContainEqual({ id: 'context', value: '300k' });
  });

  it('reads the max-mode default from the environment over the dashboard', () => {
    // Given: no environment opt-in.
    isolatedEnv();
    expect(loadConfig(join(tmpdir(), 'missing-cursor-env')).maxModeDefault).toBe(false);

    // When/Then: the explicit environment flag turns the policy on.
    vi.stubEnv('CURSOR_BRIDGE_MAX_MODE_DEFAULT', 'true');
    expect(loadConfig(join(tmpdir(), 'missing-cursor-env')).maxModeDefault).toBe(true);

    vi.stubEnv('CURSOR_BRIDGE_MAX_MODE_DEFAULT', 'false');
    expect(loadConfig(join(tmpdir(), 'missing-cursor-env')).maxModeDefault).toBe(false);
  });

  it('rejects an unparseable max-mode default instead of guessing', () => {
    // Given/When/Then: an ambiguous value fails startup.
    isolatedEnv();
    vi.stubEnv('CURSOR_BRIDGE_MAX_MODE_DEFAULT', 'yes');
    expect(() => loadConfig(join(tmpdir(), 'missing-cursor-env'))).toThrow(
      'CURSOR_BRIDGE_MAX_MODE_DEFAULT',
    );
  });
});
