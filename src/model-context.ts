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
    contextWindow: 200_000,
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

export function withCursorModelContext<T extends BridgeModel>(
  model: T,
  defaultModel = 'composer-2.5',
): T {
  const contextWindow = cursorModelContextWindow(model.id, defaultModel);
  if (contextWindow === undefined) return model;
  return {
    ...model,
    context_window: contextWindow,
    context_length: contextWindow,
    max_context_length: contextWindow,
  };
}
