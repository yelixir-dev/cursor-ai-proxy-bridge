import { describe, expect, it } from 'vitest';
import { ModelPolicy, defaultPolicy } from '../src/model-policy.js';

describe('model curation policy', () => {
  it.each([
    ['composer-2.5', true],
    ['cursor-grok-4.6-high', true],
    ['claude-fable-5-thinking-max', true],
    ['gpt-5.6-luna-xhigh', true],
    ['kimi-k3-max', true],
    ['glm-5.2-max', true],
    ['gpt-5.5-high', false],
    ['gemini-3.7-flash-high', false],
    ['cursor-grok-4.5-high', false],
    ['claude-opus-4-8-high', false],
    ['kimi-k2.7-code', false],
    ['composer-latest', false],
    ['codex-latest', false],
    ['opus-5', true],
    ['opus-5-thinking-fast', true],
    ['gpt-5.6-sol', true],
    ['grok-4.6-fast', true],
    ['kimi-k3', true],
    ['glm-5.2', true],
  ])('resolves %s to %s by default', (id, enabled) => {
    expect(defaultPolicy(id)).toBe(enabled);
  });

  it('lets explicit overrides beat defaults and reports their source', () => {
    const policy = new ModelPolicy({ 'composer-2.5': false, 'composer-latest': true });
    expect(policy.enabled('composer-2.5')).toBe(false);
    expect(policy.enabled('composer-latest')).toBe(true);
    expect(policy.source('composer-latest')).toBe('override');
    expect(policy.source('auto')).toBe('default');
  });

  it('migrates legacy-slug overrides to unified ids, later key wins', () => {
    const policy = new ModelPolicy({
      'claude-opus-5-thinking-max-fast': false,
      'gpt-5.6-sol-xhigh-fast': false,
      'gpt-5.6-sol-low-fast': true,
      'kimi-k3-max': false,
    });
    expect(policy.enabled('opus-5-thinking-fast')).toBe(false);
    expect(policy.enabled('gpt-5.6-sol-fast')).toBe(true);
    expect(policy.enabled('kimi-k3')).toBe(false);
    expect(policy.source('kimi-k3')).toBe('override');
    expect(policy.migratedFrom).toEqual({
      'claude-opus-5-thinking-max-fast': 'opus-5-thinking-fast',
      'gpt-5.6-sol-xhigh-fast': 'gpt-5.6-sol-fast',
      'gpt-5.6-sol-low-fast': 'gpt-5.6-sol-fast',
      'kimi-k3-max': 'kimi-k3',
    });
    expect(policy.snapshot()).not.toHaveProperty('kimi-k3-max');
  });

  it('migrates legacy slugs on replaceOverrides as well', () => {
    const policy = new ModelPolicy();
    policy.replaceOverrides({ 'cursor-grok-4.6-high': false });
    expect(policy.enabled('grok-4.6')).toBe(false);
    expect(policy.snapshot()).toEqual({ 'grok-4.6': false });
  });
});
