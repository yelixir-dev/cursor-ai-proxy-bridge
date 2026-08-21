import type { ChatMessage } from '../types.js';
import type { RunEmitter, RunOutcome } from './run-types.js';

type Dict = Record<string, unknown>;

export type ToolResultInput = {
  readonly id: string;
  readonly content: string;
};

export interface HeldRun {
  readonly key: string;
  /** Resumes the held Run: sends each result as mcpResult, then streams to OpenAI. */
  resume(
    resolve: (outcome: RunOutcome) => void,
    reject: (error: unknown) => void,
    results: readonly ToolResultInput[],
    emit?: RunEmitter,
  ): void;
  release(error?: Error): void;
}

function resultMessages(request: { readonly messages: readonly ChatMessage[] }): ToolResultInput[] {
  return request.messages.flatMap((message) =>
    message.role === 'tool' && typeof message.tool_call_id === 'string'
      ? [{ id: message.tool_call_id, content: message.content ?? '' }]
      : [],
  );
}

/**
 * Holds a Cursor Run that stopped on mcpArgs so the OpenAI client's next
 * request (with role=tool messages) can answer in band on the same stream.
 */
export class StickyRunStore {
  private readonly held = new Map<string, HeldRun>();

  size(): number {
    return this.held.size;
  }

  park(run: HeldRun): string[] {
    const existing = this.held.get(run.key);
    if (existing) existing.release();
    this.held.set(run.key, run);
    return [run.key];
  }

  /** Pops the held Run whose parked mcpArgs match these tool messages. */
  take(request: { readonly messages: readonly ChatMessage[] }): HeldRun | undefined {
    const results = resultMessages(request);
    if (results.length === 0) return undefined;
    const wanted = results
      .map((result) => result.id)
      .sort()
      .join('');
    const run = this.held.get(wanted);
    if (run) this.held.delete(wanted);
    return run;
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
  return [...ids].sort().join('');
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
