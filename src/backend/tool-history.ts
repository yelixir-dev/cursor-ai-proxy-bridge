import type { ChatMessage } from './types.js';

export class ToolHistoryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolHistoryValidationError';
  }
}

function invalid(message: string): never {
  throw new ToolHistoryValidationError(message);
}

export function assertValidToolHistory(messages: readonly ChatMessage[]): void {
  const seen = new Set<string>();
  const pending = new Map<string, string>();

  for (const message of messages) {
    if (pending.size > 0 && message.role !== 'tool') {
      invalid('Every assistant tool call must be followed by its matching tool result');
    }

    const calls = message.tool_calls ?? [];
    if (calls.length > 0) {
      if (message.role !== 'assistant') {
        invalid('Only assistant messages may contain tool calls');
      }
      for (const call of calls) {
        if (seen.has(call.id)) invalid(`Duplicate tool call id: ${call.id}`);
        seen.add(call.id);
        pending.set(call.id, call.function.name);
      }
    }

    if (message.role !== 'tool') continue;
    if (!message.tool_call_id) invalid('Tool result messages require tool_call_id');
    if (!pending.has(message.tool_call_id)) {
      invalid(`Unknown tool result id: ${message.tool_call_id}`);
    }
    pending.delete(message.tool_call_id);
  }

  if (pending.size > 0) {
    invalid('Every assistant tool call must have a matching tool result');
  }
}
