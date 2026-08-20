import { traceRetry } from '../../trace.js';
import { CursorBackendError } from '../cursor-cli.js';
import {
  ToolArgumentValidationError,
  type ToolArgumentValidationFailure,
  validateToolCallArguments,
} from '../tool-arguments.js';
import { parseToolCallsFromText } from '../tool-call-parse.js';
import type { ChatCompletionRequest, CompletionStreamEvent } from '../types.js';
import { enforceNativeToolChoice } from './mapper.js';
import type { CursorRun, RunEmitter, RunLifecycle, RunOutcome } from './run-types.js';
import { mapCursorApiToolRequest } from './tool-wire-names.js';
import { createSemanticOutputGate } from './visible-lifecycle.js';

export interface ValidatedRunOptions {
  readonly request: ChatCompletionRequest;
  readonly lifecycle: RunLifecycle;
  readonly run: CursorRun;
}

function retryFeedback(failure: ToolArgumentValidationFailure): string {
  return `TOOL ARGUMENT VALIDATION FEEDBACK: Your previous call to ${JSON.stringify(failure.toolName)} was invalid: ${failure.message}. Return a corrected tool call matching the declared schema.`;
}

export function choiceRequiresTool(request: ChatCompletionRequest): boolean {
  return request.tool_choice === 'required' || typeof request.tool_choice === 'object';
}

function mappedStreamEvent(
  event: CompletionStreamEvent,
  restoreToolName: (name: string) => string,
): CompletionStreamEvent {
  switch (event.type) {
    case 'thinking':
    case 'content':
    case 'tool_call_arguments_delta':
    case 'done':
      return event;
    case 'tool_call_start':
      return { ...event, name: restoreToolName(event.name) };
    case 'tool_call_complete':
      return {
        ...event,
        call: {
          ...event.call,
          function: { ...event.call.function, name: restoreToolName(event.call.function.name) },
        },
      };
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

export async function runValidatedCursorCompletion(
  options: ValidatedRunOptions,
): Promise<RunOutcome> {
  const { request, lifecycle } = options;
  const gate = createSemanticOutputGate();
  const runMapped = async (candidateRequest: ChatCompletionRequest): Promise<RunOutcome> => {
    const mapped = mapCursorApiToolRequest(candidateRequest);
    const mappedEmit: RunEmitter | undefined = lifecycle.emit
      ? Object.assign(
          (event: CompletionStreamEvent) =>
            lifecycle.emit?.(mappedStreamEvent(event, mapped.restoreToolName)),
          { reset: lifecycle.emit.reset },
        )
      : undefined;
    const candidate = await options.run(mapped.request, { ...lifecycle, emit: mappedEmit, gate });
    if (candidate.toolCalls.length) {
      return { ...candidate, toolCalls: mapped.restoreToolCalls(candidate.toolCalls) };
    }
    if (!candidate.text || !mapped.request.tools?.length) return candidate;
    const parsed = parseToolCallsFromText(candidate.text);
    const recovered = enforceNativeToolChoice(mapped.restoreToolCalls(parsed), candidateRequest);
    return recovered.length ? { ...candidate, text: '', toolCalls: recovered } : candidate;
  };

  let outcome = await runMapped(request);
  if (outcome.toolCalls.length) {
    const failure = validateToolCallArguments(outcome.toolCalls, request.tools);
    if (failure) {
      if (gate.delivered) throw new ToolArgumentValidationError(failure);
      traceRetry(lifecycle.trace, 'tool_validation');
      outcome = await runMapped({
        ...request,
        messages: [...request.messages, { role: 'user', content: retryFeedback(failure) }],
      });
      if (!outcome.toolCalls.length) {
        throw new ToolArgumentValidationError({
          toolName: failure.toolName,
          message: `${failure.message}; retry did not return a corrected tool call`,
        });
      }
      const retryFailure = validateToolCallArguments(outcome.toolCalls, request.tools);
      if (retryFailure) throw new ToolArgumentValidationError(retryFailure);
    }
  }
  if (choiceRequiresTool(request) && outcome.toolCalls.length === 0) {
    throw new CursorBackendError('Cursor did not return the required tool call');
  }
  for (const [index, call] of outcome.toolCalls.entries()) {
    lifecycle.emit?.({ type: 'tool_call_complete', index, call });
  }
  return outcome;
}
