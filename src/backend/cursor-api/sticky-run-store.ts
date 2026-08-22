import type { ChatMessage } from '../types.js';
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

export interface HeldRun {
  readonly key: string;
  readonly credentialId: string;
  /** Resumes the held Run: sends each result as mcpResult, then streams to OpenAI. */
  resume(
    resolve: (outcome: RunOutcome) => void,
    reject: (error: unknown) => void,
    results: readonly ToolResultInput[],
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

  /** Pops the held Run whose parked mcpArgs match these tool messages. */
  take(request: { readonly messages: readonly ChatMessage[] }): HeldRun | undefined {
    const results = trailingToolResults(request);
    if (results.length === 0) return undefined;
    const wanted = results.map((result) => result.id).sort();
    const key = stickyKey(wanted);
    const run = this.held.get(key);
    if (run) this.held.delete(key);
    return run;
  }

  releaseToolCalls(ids: readonly string[], error?: Error): boolean {
    const run = this.held.get(stickyKey(ids));
    return run ? this.release(run, error) : false;
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
