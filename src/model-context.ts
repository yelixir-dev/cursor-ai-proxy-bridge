import type { BridgeModel } from './backend/types.js';

export interface CursorModelContextDefinition {
  readonly family: string;
  readonly pattern: RegExp;
  readonly contextWindow: number;
  readonly sourceUrl: string;
}

export const CURSOR_MODEL_CONTEXT_DEFINITIONS: readonly CursorModelContextDefinition[] = [
  {
    family: 'composer-2.5',
    pattern: /^composer-2\.5(?:-|$)/u,
    contextWindow: 200_000,
    sourceUrl: 'https://cursor.com/docs/models/cursor-composer-2-5',
  },
  {
    family: 'opus-5',
    pattern: /^(?:claude-)?opus-5(?:-|$)/u,
    contextWindow: 300_000,
    sourceUrl: 'https://cursor.com/docs/models/claude-opus-5',
  },
  {
    family: 'sonnet-5',
    pattern: /^(?:claude-)?sonnet-5(?:-|$)/u,
    contextWindow: 300_000,
    sourceUrl: 'https://cursor.com/docs/models/claude-sonnet-5',
  },
  {
    family: 'fable-5',
    pattern: /^(?:claude-)?fable-5(?:-|$)/u,
    contextWindow: 300_000,
    sourceUrl: 'https://cursor.com/docs/models/claude-fable-5',
  },
  {
    family: 'gpt-5.6-sol',
    pattern: /^gpt-5\.6-sol(?:-|$)/u,
    contextWindow: 272_000,
    sourceUrl: 'https://cursor.com/docs/models/gpt-5-6-sol',
  },
  {
    family: 'gpt-5.6-terra',
    pattern: /^gpt-5\.6-terra(?:-|$)/u,
    contextWindow: 272_000,
    sourceUrl: 'https://cursor.com/docs/models/gpt-5-6-terra',
  },
  {
    family: 'gpt-5.6-luna',
    pattern: /^gpt-5\.6-luna(?:-|$)/u,
    contextWindow: 272_000,
    sourceUrl: 'https://cursor.com/docs/models/gpt-5-6-luna',
  },
  {
    family: 'grok-4.6',
    pattern: /^(?:cursor-)?grok-4\.6(?:-|$)/u,
    contextWindow: 256_000,
    sourceUrl: 'https://cursor.com/docs/models/grok-4-6',
  },
  {
    family: 'kimi-k3',
    pattern: /^kimi-k3(?:-|$)/u,
    contextWindow: 200_000,
    sourceUrl: 'https://cursor.com/docs/models/kimi-k3',
  },
  {
    family: 'glm-5.2',
    pattern: /^glm-5\.2(?:-|$)/u,
    contextWindow: 200_000,
    sourceUrl: 'https://cursor.com/docs/models/glm-5-2',
  },
];

// Cursor Router has no fixed context card. Use the lowest documented window
// among the bridge's curated families so proxy clients never assume Max Mode.
export const CURSOR_ROUTER_PROXY_CONTEXT_WINDOW = 200_000;

export function cursorModelContextWindow(
  modelId: string,
  defaultModel = 'composer-2.5',
): number | undefined {
  if (modelId === 'auto') return CURSOR_ROUTER_PROXY_CONTEXT_WINDOW;
  if (modelId === 'default') {
    return defaultModel === 'default'
      ? CURSOR_ROUTER_PROXY_CONTEXT_WINDOW
      : (cursorModelContextWindow(defaultModel, 'composer-2.5') ??
          CURSOR_ROUTER_PROXY_CONTEXT_WINDOW);
  }
  return CURSOR_MODEL_CONTEXT_DEFINITIONS.find((definition) => definition.pattern.test(modelId))
    ?.contextWindow;
}

/**
 * Decode a Cursor variant `context` parameter (`1m`, `300k`, `272k`) into a
 * token count. Cursor advertises the same legacy slug twice — one non-max
 * variant and one max-mode variant — so this value, not the family default,
 * is what the selected variant actually serves.
 */
export function parseCursorContextParameter(value: string): number | undefined {
  const match = /^(\d+)(k|m)$/iu.exec(value.trim());
  if (!match) return undefined;
  const magnitude = match[2]?.toLowerCase() === 'm' ? 1_000_000 : 1_000;
  return Number(match[1]) * magnitude;
}

export function withContextWindow<T extends BridgeModel>(model: T, contextWindow: number): T {
  return {
    ...model,
    context_window: contextWindow,
    context_length: contextWindow,
    max_context_length: contextWindow,
  };
}

/**
 * Apply the curated documented window. A backend that already resolved the
 * live variant window keeps it: that value comes from the exact variant the
 * request will run on, so it outranks the family default.
 */
export function withCursorModelContext<T extends BridgeModel>(
  model: T,
  defaultModel = 'composer-2.5',
): T {
  if (model.context_window !== undefined) return model;
  const contextWindow = cursorModelContextWindow(model.id, defaultModel);
  if (contextWindow === undefined) return model;
  return withContextWindow(model, contextWindow);
}
