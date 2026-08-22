import { unifiedFromSlug } from './backend/cursor-api/unified-models.js';

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
  // Unified surface ids (legacy slugs are translated before policy checks).
  /^(fable|opus|sonnet)-5(-thinking)?(-fast)?$/,
  /^gpt-5\.6-(sol|terra|luna)(-fast)?$/,
  /^grok-4\.6(-fast)?$/,
  /^kimi-k3$/,
  /^glm-5\.2$/,
] as const;

export type ModelPolicySource = 'default' | 'override';

export function defaultPolicy(id: string): boolean {
  return DEFAULT_ENABLED_MODEL_PATTERNS.some((pattern) => pattern.test(id));
}

export class ModelPolicy {
  private overrides: Record<string, boolean>;
  /** Legacy slug → unified id translations applied at load (for the startup log). */
  readonly migratedFrom: Record<string, string>;

  constructor(overrides: Record<string, boolean> = {}) {
    // Legacy variant slugs (claude-opus-5-thinking-max-fast) no longer gate
    // anything once chat checks the unified id — carry the user's intent to
    // the unified id instead of orphaning it. On collision the later key in
    // the file wins.
    const migrated: Record<string, boolean> = {};
    const from: Record<string, string> = {};
    for (const [key, enabled] of Object.entries(overrides)) {
      const unified = unifiedFromSlug(key) ?? key;
      if (unified !== key) from[key] = unified;
      migrated[unified] = enabled;
    }
    this.overrides = migrated;
    this.migratedFrom = from;
  }

  enabled(id: string): boolean {
    return this.overrides[id] ?? defaultPolicy(id);
  }

  source(id: string): ModelPolicySource {
    return Object.hasOwn(this.overrides, id) ? 'override' : 'default';
  }

  replaceOverrides(overrides: Record<string, boolean>): void {
    const migrated: Record<string, boolean> = {};
    for (const [key, enabled] of Object.entries(overrides)) {
      migrated[unifiedFromSlug(key) ?? key] = enabled;
    }
    this.overrides = migrated;
  }

  snapshot(): Record<string, boolean> {
    return { ...this.overrides };
  }
}
