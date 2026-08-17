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
});
