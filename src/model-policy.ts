const DEFAULT_ENABLED_MODEL_PATTERNS = [
  /^composer-2\.5(-fast)?$/,
  /^cursor-grok-4\.6-/,
  /^claude-opus-5-/,
  /^claude-sonnet-5-/,
  /^claude-fable-5-/,
  /^gpt-5\.6-(sol|terra|luna)-/,
  /^kimi-k3-/,
  /^glm-5\.2-/,
  /^(default|auto)$/,
] as const;

export type ModelPolicySource = 'default' | 'override';

export function defaultPolicy(id: string): boolean {
  return DEFAULT_ENABLED_MODEL_PATTERNS.some((pattern) => pattern.test(id));
}

export class ModelPolicy {
  private overrides: Record<string, boolean>;

  constructor(overrides: Record<string, boolean> = {}) {
    this.overrides = { ...overrides };
  }

  enabled(id: string): boolean {
    return this.overrides[id] ?? defaultPolicy(id);
  }

  source(id: string): ModelPolicySource {
    return Object.hasOwn(this.overrides, id) ? 'override' : 'default';
  }

  replaceOverrides(overrides: Record<string, boolean>): void {
    this.overrides = { ...overrides };
  }

  snapshot(): Record<string, boolean> {
    return { ...this.overrides };
  }
}
