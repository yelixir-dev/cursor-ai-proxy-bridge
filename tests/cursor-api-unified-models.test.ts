import { describe, expect, it } from 'vitest';
import { runRequestMessage } from '../src/backend/cursor-api/mapper.js';
import type { RequestedModel } from '../src/backend/cursor-api/requested-models.js';
import {
  resolveVariantSlug,
  unifiedFromSlug,
  unifiedModelList,
} from '../src/backend/cursor-api/unified-models.js';
import type { BridgeModel } from '../src/backend/types.js';

const LIVE_SLUGS = [
  'claude-opus-5-low',
  'claude-opus-5-medium',
  'claude-opus-5-high',
  'claude-opus-5-xhigh',
  'claude-opus-5-max',
  'claude-opus-5-thinking-low-fast',
  'claude-opus-5-thinking-medium-fast',
  'claude-opus-5-thinking-high-fast',
  'claude-opus-5-thinking-xhigh-fast',
  'claude-opus-5-thinking-max-fast',
  'gpt-5.6-sol-none',
  'gpt-5.6-sol-low',
  'gpt-5.6-sol-medium',
  'gpt-5.6-sol-high',
  'gpt-5.6-sol-xhigh',
  'gpt-5.6-sol-max',
  'gpt-5.6-sol-high-fast',
  'cursor-grok-4.6-low',
  'cursor-grok-4.6-medium',
  'cursor-grok-4.6-high',
  'kimi-k3-low',
  'kimi-k3-high',
  'kimi-k3-max',
  'glm-5.2-high',
  'glm-5.2-max',
  'composer-2.5',
  'auto',
];

function model(id: string): BridgeModel {
  return { id, object: 'model', created: 1, owned_by: 'cursor' };
}

describe('unified model surface', () => {
  it('maps legacy slugs to unified ids', () => {
    expect(unifiedFromSlug('claude-opus-5-thinking-max-fast')).toBe('opus-5-thinking-fast');
    expect(unifiedFromSlug('claude-fable-5-high')).toBe('fable-5');
    expect(unifiedFromSlug('gpt-5.6-sol-xhigh-fast')).toBe('gpt-5.6-sol-fast');
    expect(unifiedFromSlug('gpt-5.6-terra-none')).toBe('gpt-5.6-terra');
    expect(unifiedFromSlug('cursor-grok-4.6-high-fast')).toBe('grok-4.6-fast');
    expect(unifiedFromSlug('kimi-k3-max')).toBe('kimi-k3');
    expect(unifiedFromSlug('glm-5.2-high')).toBe('glm-5.2');
    expect(unifiedFromSlug('composer-2.5')).toBeUndefined();
    expect(unifiedFromSlug('auto')).toBeUndefined();
  });

  it('collapses the live list to unified ids in stable order', () => {
    const listed = unifiedModelList(LIVE_SLUGS.map(model)).map((entry) => entry.id);
    expect(listed).toEqual([
      'opus-5',
      'opus-5-thinking-fast',
      'gpt-5.6-sol',
      'gpt-5.6-sol-fast',
      'grok-4.6',
      'kimi-k3',
      'glm-5.2',
      'composer-2.5',
      'auto',
    ]);
  });

  it('resolves unified ids with default effort medium', () => {
    expect(resolveVariantSlug('opus-5', undefined, LIVE_SLUGS)).toBe('claude-opus-5-medium');
    expect(resolveVariantSlug('gpt-5.6-sol-fast', undefined, LIVE_SLUGS)).toBe(
      'gpt-5.6-sol-high-fast',
    );
  });

  it('honors an explicit reasoning_effort', () => {
    expect(resolveVariantSlug('opus-5-thinking-fast', 'max', LIVE_SLUGS)).toBe(
      'claude-opus-5-thinking-max-fast',
    );
    expect(resolveVariantSlug('gpt-5.6-sol', 'none', LIVE_SLUGS)).toBe('gpt-5.6-sol-none');
  });

  it('falls back to high for families without medium', () => {
    expect(resolveVariantSlug('kimi-k3', undefined, LIVE_SLUGS)).toBe('kimi-k3-high');
    expect(resolveVariantSlug('glm-5.2', 'medium', LIVE_SLUGS)).toBe('glm-5.2-high');
  });

  it('passes legacy slugs through and rejects unknown models', () => {
    expect(resolveVariantSlug('claude-opus-5-max', undefined, LIVE_SLUGS)).toBe(
      'claude-opus-5-max',
    );
    expect(resolveVariantSlug('not-a-model', undefined, LIVE_SLUGS)).toBeUndefined();
  });

  it('puts the resolved variant parameters on the wire run request', () => {
    const resolved: RequestedModel = {
      modelId: 'claude-opus-5',
      maxMode: false,
      parameters: [
        { id: 'effort', value: 'max' },
        { id: 'thinking', value: 'true' },
      ],
      builtInModel: false,
      isVariantStringRepresentation: false,
    };
    const message = runRequestMessage(
      { model: 'opus-5-thinking-fast', messages: [{ role: 'user', content: 'hi' }] },
      'req-1',
      new Map(),
      undefined,
      resolved,
    );
    const value = (message.message as { value: Record<string, unknown> }).value;
    const requestedModel = value.requestedModel as {
      modelId: string;
      parameters: Array<{ id: string; value: string }>;
    };
    expect(requestedModel.modelId).toBe('claude-opus-5');
    expect(requestedModel.parameters).toEqual([
      { id: 'effort', value: 'max' },
      { id: 'thinking', value: 'true' },
    ]);
  });
});
