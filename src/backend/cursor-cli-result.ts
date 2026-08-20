import { z } from 'zod';
import { CursorBackendError } from './cursor-cli-errors.js';
import type {
  ChatCompletionRequest,
  CompletionResult,
  CompletionUsage,
  ToolCall,
  UsageSource,
} from './types.js';

const cursorObjectSchema = z
  .object({
    is_error: z.unknown().optional(),
    result: z.unknown().optional(),
    message: z.unknown().optional(),
    usage: z.unknown().optional(),
    type: z.unknown().optional(),
    subtype: z.unknown().optional(),
    text: z.unknown().optional(),
  })
  .passthrough();
const usageSchema = z
  .object({
    inputTokens: z.unknown().optional(),
    outputTokens: z.unknown().optional(),
  })
  .passthrough();
const assistantMessageSchema = z.object({ content: z.unknown().optional() }).passthrough();
const assistantBlockSchema = z.object({ text: z.unknown().optional() }).passthrough();

type CursorObject = z.infer<typeof cursorObjectSchema>;

export function cursorUsage(raw: unknown): CompletionUsage | undefined {
  const parsed = usageSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const promptTokens = parsed.data.inputTokens;
  const completionTokens = parsed.data.outputTokens;
  if (
    typeof promptTokens !== 'number' ||
    !Number.isFinite(promptTokens) ||
    promptTokens < 0 ||
    typeof completionTokens !== 'number' ||
    !Number.isFinite(completionTokens) ||
    completionTokens < 0
  ) {
    return undefined;
  }
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function estimatedUsage(prompt: string, output: string): CompletionUsage {
  const promptTokens = estimateTokens(prompt);
  const completionTokens = estimateTokens(output);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

export type ParsedCursorResult = {
  readonly text: string;
  readonly usage: CompletionUsage;
  readonly usageSource: UsageSource;
};

export function parseCursorResult(output: string, prompt: string): ParsedCursorResult {
  let candidate: unknown;
  try {
    candidate = JSON.parse(output);
  } catch {
    return { text: output, usage: estimatedUsage(prompt, output), usageSource: 'estimated' };
  }
  const parsed = cursorObjectSchema.safeParse(candidate);
  if (!parsed.success) {
    return { text: output, usage: estimatedUsage(prompt, output), usageSource: 'estimated' };
  }

  if (parsed.data.is_error === true) {
    const message =
      typeof parsed.data.result === 'string' && parsed.data.result.trim()
        ? parsed.data.result.trim()
        : typeof parsed.data.message === 'string' && parsed.data.message.trim()
          ? parsed.data.message.trim()
          : 'Cursor returned an error';
    throw new CursorBackendError(message);
  }
  if (typeof parsed.data.result !== 'string') {
    return { text: output, usage: estimatedUsage(prompt, output), usageSource: 'estimated' };
  }
  const reportedUsage = cursorUsage(parsed.data.usage);
  return {
    text: parsed.data.result,
    usage: reportedUsage ?? estimatedUsage(prompt, parsed.data.result),
    usageSource: reportedUsage ? 'cli_reported' : 'estimated',
  };
}

export function parseCursorStreamObject(value: unknown): CursorObject | undefined {
  const parsed = cursorObjectSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function assistantText(event: CursorObject): string | undefined {
  const message = assistantMessageSchema.safeParse(event.message);
  if (!message.success) return undefined;
  const content = message.data.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((block) => {
      const parsed = assistantBlockSchema.safeParse(block);
      return parsed.success && typeof parsed.data.text === 'string' ? parsed.data.text : '';
    })
    .join('');
  return text || undefined;
}

export type CapturedToolCompletion = {
  readonly request: ChatCompletionRequest;
  readonly toolCalls: readonly ToolCall[];
  readonly usage: CompletionUsage;
  readonly usageSource: UsageSource;
};

export function completionFromCapturedTools(completion: CapturedToolCompletion): CompletionResult {
  return {
    content: null,
    model: completion.request.model,
    tool_calls: [...completion.toolCalls],
    usage: completion.usage,
    usage_source: completion.usageSource,
  };
}
