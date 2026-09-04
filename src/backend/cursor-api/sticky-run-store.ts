import { createHash } from 'node:crypto';
import type { ChatCompletionRequest, ChatMessage } from '../types.js';
import { nativeToolDefinition } from './mapper.js';
import type { RunEmitter, RunOutcome } from './run-types.js';

type Dict = Record<string, unknown>;
export const DEFAULT_MAX_HELD_RUNS = 128;

export class StickyRunCapacityError extends Error {
  constructor(readonly capacity: number) {
    super(`Cursor sticky Run capacity ${capacity} exceeded`);
    this.name = 'StickyRunCapacityError';
  }
}

export type ToolResultInput = {
  readonly id: string;
  readonly content: string;
};

/** Immutable value snapshot; never retains mutable request/history references. */
export interface ContinuationContract {
  readonly fingerprint: string;
}

/**
 * Capture the mapped request and expected history through the surfaced assistant
 * message, excluding the next tool results. On later rounds use the latest
 * resumed request, not the request that originally opened the Run.
 */
export function captureContinuationContract(
  request: ChatCompletionRequest,
  maxMode: boolean,
  expectedMessages: readonly ChatMessage[] = request.messages,
): ContinuationContract {
  const effort = request.reasoning_effort;
  const defaultEffort = ['kimi-k3', 'glm-5.2'].includes(request.model) ? 'high' : 'medium';
  const fingerprint = JSON.stringify(
    {
      model: request.model,
      reasoningEffort: !effort || effort === 'default' ? defaultEffort : effort,
      tools: (request.tools ?? []).map(nativeToolDefinition),
      toolChoice: request.tool_choice ?? 'auto',
      parallelToolCalls: request.parallel_tool_calls !== false,
      maxToolCalls: request.max_tool_calls ?? null,
      maxMode,
      temperature: request.temperature ?? null,
      maxTokens: request.max_tokens ?? null,
      messages: expectedMessages.map((message) => ({
        role: message.role,
        content: message.content ?? '',
        toolCallId: message.tool_call_id ?? null,
        toolCalls: (message.tool_calls ?? []).map((call) => ({
          id: call.id,
          type: call.type,
          name: call.function.name,
          arguments: call.function.arguments,
        })),
      })),
    },
    // Object key insertion order is not semantic; array/call/schema order is.
    (_key, value: unknown) =>
      value !== null && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value).sort(([left], [right]) =>
              left < right ? -1 : left > right ? 1 : 0,
            ),
          )
        : value,
  );
  return Object.freeze({ fingerprint: createHash('sha256').update(fingerprint).digest('hex') });
}

export interface HeldRun {
  readonly key: string;
  readonly credentialId: string;
  readonly continuation: ContinuationContract;
  /** Resumes the held Run: sends each result as mcpResult, then streams to OpenAI. */
  resume(
    resolve: (outcome: RunOutcome) => void,
    reject: (error: unknown) => void,
    results: readonly ToolResultInput[],
    request: ChatCompletionRequest,
    emit?: RunEmitter,
    signal?: AbortSignal,
  ): void;
  release(error?: Error): void;
}

export function trailingToolResults(request: {
  readonly messages: readonly ChatMessage[];
}): ToolResultInput[] {
  if (request.messages.at(-1)?.role !== 'tool') return [];
  const results: ToolResultInput[] = [];
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const message = request.messages[index];
    if (message?.role !== 'tool') break;
    if (typeof message.tool_call_id === 'string') {
      results.unshift({ id: message.tool_call_id, content: message.content ?? '' });
    }
  }
  return results;
}

/**
 * Holds a Cursor Run that stopped on mcpArgs so the OpenAI client's next
 * request (with role=tool messages) can answer in band on the same stream.
 */
export class StickyRunStore {
  private readonly held = new Map<string, HeldRun>();

  constructor(private readonly capacity = DEFAULT_MAX_HELD_RUNS) {}

  size(): number {
    return this.held.size;
  }

  park(run: HeldRun): string[] {
    const existing = this.held.get(run.key);
    if (existing) existing.release();
    else if (this.held.size >= this.capacity) {
      const oldest = this.held.values().next();
      if (!oldest.done) {
        this.held.delete(oldest.value.key);
        oldest.value.release(new StickyRunCapacityError(this.capacity));
      }
    }
    this.held.set(run.key, run);
    return [run.key];
  }

  /** Pops a compatible hold; matching IDs with a changed contract release it. */
  take(request: ChatCompletionRequest, maxMode: boolean): HeldRun | undefined {
    const results = trailingToolResults(request);
    if (results.length === 0) return undefined;
    const wanted = results.map((result) => result.id).sort();
    const key = stickyKey(wanted);
    const run = this.held.get(key);
    if (!run) return undefined;
    const candidate = captureContinuationContract(
      request,
      maxMode,
      request.messages.slice(0, -results.length),
    );
    if (candidate.fingerprint !== run.continuation.fingerprint) {
      this.release(run);
      return undefined;
    }
    this.held.delete(key);
    return run;
  }

  releaseToolCalls(ids: readonly string[], error?: Error): boolean {
    const run = this.held.get(stickyKey(ids));
    return run ? this.release(run, error) : false;
  }

  /** Invalidates only holds owned by a replaced, removed, or disabled credential. */
  releaseCredential(credentialId: string, error?: Error): number {
    let released = 0;
    for (const run of this.held.values()) {
      if (run.credentialId === credentialId && this.release(run, error)) released += 1;
    }
    return released;
  }

  release(run: HeldRun, error?: Error): boolean {
    if (this.held.get(run.key) !== run) return false;
    this.held.delete(run.key);
    run.release(error);
    return true;
  }

  forEach(fn: (run: HeldRun) => void): void {
    for (const run of this.held.values()) fn(run);
  }

  clear(error?: Error): void {
    for (const run of this.held.values()) run.release(error);
    this.held.clear();
  }
}

export function stickyKey(ids: readonly string[]): string {
  return JSON.stringify([...ids].sort());
}

export function heldExecToKey(execs: ReadonlyArray<{ readonly exec: Dict }>): string {
  return stickyKey(
    execs.map((held) => {
      const message = held.exec.message as Dict | undefined;
      const value = message?.value as Dict | undefined;
      return String(value?.toolCallId ?? '');
    }),
  );
}
