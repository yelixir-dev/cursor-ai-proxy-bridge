import type { BridgeTraceScope } from './bridge-trace.js';
import type { TimedOmoEvent } from './omo-process.js';
import type { BenchmarkLane } from './types.js';

export type ModelVisibleAssistantEvent = 'content' | 'tool_decision';
export type CancellationOutcome =
  | 'armed'
  | 'waiting_for_run_open'
  | 'cancel_sent'
  | 'barrier_timeout';

type EventObject = Record<string, unknown>;

function object(value: unknown): EventObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as EventObject)
    : null;
}

function nonemptyContent(value: unknown): boolean {
  if (typeof value === 'string') return value.length > 0;
  return Array.isArray(value) && value.length > 0;
}

export function classifyModelVisibleAssistantEvent(
  event: TimedOmoEvent,
): ModelVisibleAssistantEvent | null {
  const outer = event.value as EventObject;
  const nested = object(outer.assistantMessageEvent);
  const value = nested ?? outer;
  const type = typeof value.type === 'string' ? value.type : '';
  switch (type) {
    case 'text_delta':
      return nonemptyContent(value.delta) ? 'content' : null;
    case 'toolcall_start':
    case 'toolcall_delta':
    case 'toolcall_end':
      return 'tool_decision';
    case 'message_end': {
      const message = object(value.message) ?? value;
      if (message.role !== 'assistant') return null;
      if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        return 'tool_decision';
      }
      return nonemptyContent(message.content) ? 'content' : null;
    }
    case 'agent_start':
    case 'agent_end':
    case 'session':
    case 'session_info':
    case 'start':
    case 'done':
    case 'status':
    case 'custom':
    case 'custom_message':
    case 'thinking_start':
    case 'thinking_delta':
    case 'thinking_end':
    case 'tool_execution_start':
    case 'tool_execution_end':
    case 'error':
    case 'aborted':
      return null;
    default:
      return null;
  }
}

export interface CancellationTriggerOptions {
  lane: BenchmarkLane;
  after: 'first_event' | 'tool_decision';
  timeoutMs: number;
  abort(): void;
  barrier: Pick<BridgeTraceScope, 'waitForSynchronizedRunOpen'>;
  externalSignal?: AbortSignal;
}

export interface CancellationTrigger {
  onEvent(event: TimedOmoEvent): void;
  settle(): Promise<void>;
  stop(): void;
  outcome(): CancellationOutcome;
}

export function createCancellationTrigger(
  options: CancellationTriggerOptions,
): CancellationTrigger {
  let outcome: CancellationOutcome = 'armed';
  let stopped = false;
  let pending: Promise<void> = Promise.resolve();
  const send = (): void => {
    if (outcome === 'cancel_sent') return;
    outcome = 'cancel_sent';
    options.abort();
  };
  return {
    onEvent(event) {
      if (stopped || outcome !== 'armed') return;
      const visible = classifyModelVisibleAssistantEvent(event);
      if (!visible || (options.after === 'tool_decision' && visible !== 'tool_decision')) return;
      if (options.lane === 'native') {
        send();
        return;
      }
      outcome = 'waiting_for_run_open';
      pending = options.barrier
        .waitForSynchronizedRunOpen(options.timeoutMs, options.externalSignal)
        .then((observed) => {
          if (observed) send();
          else outcome = 'barrier_timeout';
        });
    },
    settle: () => pending,
    stop() {
      stopped = true;
    },
    outcome: () => outcome,
  };
}
