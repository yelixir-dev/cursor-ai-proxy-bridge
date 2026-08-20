import { isDeepStrictEqual } from 'node:util';
import type { ToolCall } from './backend/types.js';

export type OpenAiToolCallDelta = {
  readonly index: number;
  readonly id?: string;
  readonly type?: 'function';
  readonly function?: {
    readonly name?: string;
    readonly arguments?: string;
  };
};

/** Stream reconstruction state: mutation is the purpose of this accumulator. */
type CallState = {
  readonly index: number;
  readonly id: string;
  readonly name: string;
  arguments: string;
  completed?: ToolCall;
};

export class OpenAiToolStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenAiToolStreamError';
  }
}

export class OpenAiToolStreamAccumulator {
  private readonly calls = new Map<number, CallState>();
  private readonly indexesById = new Map<string, number>();

  start(index: number, id: string, name: string): OpenAiToolCallDelta[] {
    const existing = this.calls.get(index);
    if (existing) {
      if (existing.id !== id || existing.name !== name) {
        throw new OpenAiToolStreamError(`Tool call index ${index} changed identity`);
      }
      return [];
    }
    const existingIndex = this.indexesById.get(id);
    if (existingIndex !== undefined && existingIndex !== index) {
      throw new OpenAiToolStreamError(`Tool call ${JSON.stringify(id)} changed index`);
    }
    this.calls.set(index, { index, id, name, arguments: '' });
    this.indexesById.set(id, index);
    return [
      {
        index,
        id,
        type: 'function',
        function: { name, arguments: '' },
      },
    ];
  }

  append(index: number, id: string, delta: string): OpenAiToolCallDelta[] {
    const state = this.calls.get(index);
    if (!state || state.id !== id) {
      throw new OpenAiToolStreamError(`Arguments arrived before tool call ${index} started`);
    }
    if (state.completed) {
      throw new OpenAiToolStreamError(`Arguments arrived after tool call ${index} completed`);
    }
    state.arguments += delta;
    return delta ? [{ index, function: { arguments: delta } }] : [];
  }

  complete(index: number, call: ToolCall): OpenAiToolCallDelta[] {
    const existing = this.calls.get(index);
    if (!existing) {
      this.calls.set(index, {
        index,
        id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
        completed: call,
      });
      this.indexesById.set(call.id, index);
      return [
        {
          index,
          id: call.id,
          type: 'function',
          function: {
            name: call.function.name,
            arguments: call.function.arguments,
          },
        },
      ];
    }
    if (existing.completed) {
      if (!isDeepStrictEqual(existing.completed, call)) {
        throw new OpenAiToolStreamError(`Tool call ${index} completed twice with different data`);
      }
      return [];
    }
    if (existing.id !== call.id || existing.name !== call.function.name) {
      throw new OpenAiToolStreamError(`Tool call ${index} completed with a different identity`);
    }
    if (!call.function.arguments.startsWith(existing.arguments)) {
      throw new OpenAiToolStreamError(`Tool call ${index} completed with incompatible arguments`);
    }
    const suffix = call.function.arguments.slice(existing.arguments.length);
    existing.arguments = call.function.arguments;
    existing.completed = call;
    return suffix ? [{ index, function: { arguments: suffix } }] : [];
  }

  get hasCalls(): boolean {
    return this.calls.size > 0;
  }

  finish(): 'stop' | 'tool_calls' {
    if (this.calls.size === 0) return 'stop';
    for (const state of this.calls.values()) {
      if (!state.completed) {
        throw new OpenAiToolStreamError(`Tool call ${state.index} never completed`);
      }
    }
    return 'tool_calls';
  }
}
