import { sha256Hex } from './hash-json.js';
import { readCall, type ObservedCall } from './observed-call.js';
import type { NormalizedEvent } from './types.js';

export { sha256Hex, stableJson } from './hash-json.js';

export interface NormalizeOptions {
  sentinel?: string;
  peerSentinels?: readonly string[];
}

export interface EventObservation {
  events: NormalizedEvent[];
  calls: ObservedCall[];
  executions: Array<{ callId: string; name: string; isError: boolean }>;
  visibleText: string;
  firstSemanticGrapheme: string | null;
  assistantStopReasons: Record<string, number>;
  erroredAssistantTurns: number;
  assistantErrorText: string;
}

type Dict = Record<string, unknown>;
const SEGMENTER = new Intl.Segmenter('en', { granularity: 'grapheme' });

function dict(value: unknown): Dict | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Dict)
    : undefined;
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function stripToolPayloads(text: string): string {
  const next = text
    .replace(/\[TOOL_CALLS:\s*\[[\s\S]*?\]\]/g, '')
    .replace(/```(?:json)?\s*\{[\s\S]*?"(?:tool_calls|function_call)"[\s\S]*?```/gi, '');
  return /^\s*\{[\s\S]*"(?:tool_calls|function_call)"/.test(next) ? '' : next;
}

export function observeEvents(
  rawEvents: readonly unknown[],
  options: NormalizeOptions = {},
): EventObservation {
  const events: NormalizedEvent[] = [];
  const calls: ObservedCall[] = [];
  const executions: Array<{ callId: string; name: string; isError: boolean }> = [];
  const seenIds = new Set<string>();
  let visibleText = '';
  let firstGrapheme: string | null = null;
  const assistantStopReasons: Record<string, number> = {};
  let erroredAssistantTurns = 0;
  let assistantErrorText = '';
  let lastAssistantErrored = false;
  let accepted = false;
  let firstByte = false;
  let thinking = false;
  let decided = false;
  let aborted = false;
  let terminal = false;
  let streamedText = false;
  let crosstalk = false;
  const emit = (event: NormalizedEvent): number => events.push(event);
  const mark = (atMs: number, stream = false): void => {
    if (!accepted) {
      accepted = true;
      emit({ type: 'accepted', atMs });
    }
    if (stream && !firstByte) {
      firstByte = true;
      emit({ type: 'first_byte', atMs });
    }
  };
  const decide = (atMs: number): void => {
    mark(atMs, true);
    if (!decided) {
      decided = true;
      emit({ type: 'tool_decision', atMs });
    }
  };
  const noteCall = (call: ObservedCall | undefined, atMs: number): void => {
    if (!call || seenIds.has(call.callId)) return;
    seenIds.add(call.callId);
    decide(atMs);
    calls.push(call);
    if (!call.valid) emit({ type: 'error', atMs, failureClass: 'invalid_tool_args' });
    else {
      emit({
        type: 'complete_call',
        atMs,
        callIndex: calls.length - 1,
        callIdHash: call.callIdHash,
        name: call.name,
        argumentsHash: call.argumentsHash,
      });
    }
  };
  const ingestText = (raw: string, atMs: number): void => {
    if (!raw) return;
    mark(atMs, true);
    streamedText = true;
    const visible = stripToolPayloads(raw);
    if (!visible) return;
    visibleText += visible;
    if (!firstGrapheme) {
      for (const { segment } of SEGMENTER.segment(visibleText)) {
        if (/\p{L}|\p{N}/u.test(segment)) {
          firstGrapheme = segment;
          break;
        }
      }
    }
    emit({
      type: 'text',
      atMs,
      charCount: visible.length,
      sentinelObserved: Boolean(options.sentinel && visibleText.includes(options.sentinel)),
    });
    if (!crosstalk && options.peerSentinels?.some((item) => visibleText.includes(item))) {
      crosstalk = true;
      emit({ type: 'error', atMs, failureClass: 'crosstalk' });
    }
  };

  for (const [index, raw] of rawEvents.entries()) {
    const rec = dict(raw) ?? {};
    const inner = dict(rec.assistantMessageEvent) ?? rec;
    const atMs = typeof rec.atMs === 'number' ? rec.atMs : Number(rec.timestamp ?? index);
    const kind = textOf(inner.type) || textOf(rec.type);
    if (aborted && kind !== 'agent_end' && kind !== 'done') {
      emit({ type: 'error', atMs, failureClass: 'late_after_abort' });
    }
    if (kind === 'agent_start' || kind === 'session' || kind === 'start') mark(atMs);
    else if (kind.startsWith('thinking')) {
      mark(atMs, true);
      if (!thinking) {
        thinking = true;
        emit({ type: 'thinking', atMs });
      }
    } else if (kind === 'text_delta') ingestText(textOf(inner.delta), atMs);
    else if (kind === 'toolcall_start') decide(atMs);
    else if (kind === 'toolcall_delta') {
      mark(atMs, true);
      emit({
        type: 'tool_args_delta',
        atMs,
        callIndex: calls.length,
        byteCount: Buffer.byteLength(textOf(inner.delta)),
      });
    } else if (kind === 'toolcall_end') {
      noteCall(readCall(inner.toolCall, `call_${calls.length}`), atMs);
    } else if (kind === 'tool_execution_start') {
      mark(atMs, true);
      const callId = textOf(inner.toolCallId);
      emit({
        type: 'execution_start',
        atMs,
        callIdHash: sha256Hex(callId),
        name: textOf(inner.toolName),
      });
    } else if (kind === 'tool_execution_end') {
      const execution = {
        callId: textOf(inner.toolCallId),
        name: textOf(inner.toolName),
        isError: inner.isError === true,
      };
      emit({
        type: 'execution_end',
        atMs,
        callIdHash: sha256Hex(execution.callId),
        name: execution.name,
        isError: execution.isError,
      });
      executions.push(execution);
    } else if (kind === 'message_end') {
      const message = dict(inner.message) ?? inner;
      const role = textOf(message.role);
      const stopReason = textOf(message.stopReason);
      const errorMessage = textOf(message.errorMessage);
      if (role === 'assistant' || stopReason || errorMessage) {
        if (stopReason) {
          assistantStopReasons[stopReason] = (assistantStopReasons[stopReason] ?? 0) + 1;
        }
        const errored = stopReason === 'error' || errorMessage !== '';
        if (errored) {
          erroredAssistantTurns += 1;
          if (!assistantErrorText && errorMessage) assistantErrorText = errorMessage.slice(0, 512);
        }
        if (stopReason) lastAssistantErrored = errored;
        else if (errored) lastAssistantErrored = true;
      }
      if (Array.isArray(message.tool_calls)) {
        for (const item of message.tool_calls) {
          noteCall(readCall(item, `call_${calls.length}`), atMs);
        }
      }
      if (typeof message.content === 'string' && !streamedText) ingestText(message.content, atMs);
    } else if (kind === 'aborted' || (kind === 'error' && inner.reason === 'aborted')) {
      aborted = true;
      emit({ type: 'aborted', atMs });
    } else if ((kind === 'agent_end' || kind === 'done') && !terminal) {
      terminal = true;
      emit({
        type: 'terminal',
        atMs,
        reason: aborted ? 'aborted' : lastAssistantErrored ? 'error' : 'completed',
      });
    } else if (kind === 'error' && !terminal) {
      terminal = true;
      emit({ type: 'terminal', atMs, reason: 'error' });
    }
  }

  return {
    events,
    calls,
    executions,
    visibleText,
    firstSemanticGrapheme: firstGrapheme,
    assistantStopReasons,
    erroredAssistantTurns,
    assistantErrorText,
  };
}

export function normalizeEvents(
  rawEvents: readonly unknown[],
  options?: NormalizeOptions,
): NormalizedEvent[] {
  return observeEvents(rawEvents, options).events;
}

export function firstSemanticGrapheme(
  rawEvents: readonly unknown[],
  options?: NormalizeOptions,
): string | null {
  return observeEvents(rawEvents, options).firstSemanticGrapheme;
}
