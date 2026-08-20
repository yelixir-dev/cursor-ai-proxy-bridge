import type { CompletionUsage, UsageSource } from '../types.js';

export interface CursorUsageAttribution {
  readonly usage: CompletionUsage;
  readonly source: UsageSource;
}

function finiteToken(value: unknown): number {
  if (typeof value === 'bigint') return Number(value);
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function cursorUsageAttribution(
  turnEnded?: Record<string, unknown>,
): CursorUsageAttribution {
  if (!turnEnded) {
    return {
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      source: 'unknown',
    };
  }
  const prompt = finiteToken(turnEnded.inputTokens);
  const completion = finiteToken(turnEnded.outputTokens);
  return {
    usage: {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion,
    },
    source: 'turnEnded',
  };
}
