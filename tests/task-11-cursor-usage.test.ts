import { describe, expect, it } from 'vitest';
import { cursorUsageAttribution } from '../src/backend/cursor-api/usage-attribution.js';

describe('task 11 cursor-api usage attribution', () => {
  it('uses unknown zero before an upstream turnEnded frame', () => {
    expect(cursorUsageAttribution()).toEqual({
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      source: 'unknown',
    });
  });

  it('uses authoritative turnEnded token counts without estimation', () => {
    expect(cursorUsageAttribution({ inputTokens: 12, outputTokens: 5 })).toEqual({
      usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
      source: 'turnEnded',
    });
  });
});
