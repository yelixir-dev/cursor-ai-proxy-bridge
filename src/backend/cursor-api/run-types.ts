import type {
  ChatCompletionRequest,
  CompletionStreamEvent,
  CompletionUsage,
  ToolCall,
  UsageSource,
} from '../types.js';
import type { SemanticOutputGate } from './visible-lifecycle.js';

export interface RunOutcome {
  readonly text: string;
  readonly toolCalls: ToolCall[];
  readonly usage: CompletionUsage;
  readonly usageSource: UsageSource;
}

export interface RunEmitter {
  (event: CompletionStreamEvent): boolean | undefined;
  reset?(): void;
}

export interface RunLifecycle {
  readonly signal?: AbortSignal;
  readonly emit?: RunEmitter;
  readonly trace?: import('../../trace.js').RequestTrace;
  /** Shared across every Run of one request; see createSemanticOutputGate. */
  readonly gate?: SemanticOutputGate;
}

export type CursorRun = (
  request: ChatCompletionRequest,
  lifecycle: RunLifecycle,
) => Promise<RunOutcome>;
