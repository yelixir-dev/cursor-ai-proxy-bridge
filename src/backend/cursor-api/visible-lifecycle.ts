import type { CompletionStreamEvent } from '../types.js';

export function isClientVisibleRunEvent(event: CompletionStreamEvent): boolean {
  switch (event.type) {
    case 'content':
    case 'tool_call_start':
    case 'tool_call_arguments_delta':
    case 'tool_call_complete':
      return true;
    case 'thinking':
    case 'done':
      return false;
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

export interface SemanticOutputGate {
  /** True once any client-visible semantic event has been delivered. */
  readonly delivered: boolean;
  /** Records one emitted event and whether the client actually received it. */
  record(event: CompletionStreamEvent, received: boolean | undefined): void;
}

/**
 * Request-scoped visibility shared by every upstream Run of one request, so a
 * validation retry has the same replay eligibility as transport retries.
 */
export function createSemanticOutputGate(): SemanticOutputGate {
  let deliveredSemanticOutput = false;
  return {
    get delivered() {
      return deliveredSemanticOutput;
    },
    record(event, received) {
      if (received !== false && isClientVisibleRunEvent(event)) deliveredSemanticOutput = true;
    },
  };
}
