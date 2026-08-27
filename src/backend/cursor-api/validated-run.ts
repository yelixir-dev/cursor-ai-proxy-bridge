import { traceRetry } from '../../trace.js';
import { CursorBackendError } from '../cursor-cli.js';
import {
  ToolArgumentValidationError,
  type ToolArgumentValidationFailure,
  validateToolCallArguments,
} from '../tool-arguments.js';
import { parseToolCallsFromText } from '../tool-call-parse.js';
import { capToolCallsForRequest } from '../tool-call-policy.js';
import type { ChatCompletionRequest, CompletionStreamEvent, ToolCall } from '../types.js';
import { enforceNativeToolChoice } from './mapper.js';
import { CursorBuiltinToolCallError } from './run-messages.js';
import type { CursorRun, RunEmitter, RunLifecycle, RunOutcome } from './run-types.js';
import { mapCursorApiToolRequest } from './tool-wire-names.js';
import { createSemanticOutputGate } from './visible-lifecycle.js';

export interface ValidatedRunOptions {
  readonly request: ChatCompletionRequest;
  readonly lifecycle: RunLifecycle;
  readonly run: CursorRun;
  readonly onToolValidationFailure?: (calls: readonly ToolCall[], error: Error) => void;
}

function retryFeedback(failure: ToolArgumentValidationFailure): string {
  return `TOOL ARGUMENT VALIDATION FEEDBACK: Your previous call to ${JSON.stringify(failure.toolName)} was invalid: ${failure.message}. Return a corrected tool call matching the declared schema.`;
}

function builtinRecoveryRequest(
  request: ChatCompletionRequest,
  error: unknown,
): ChatCompletionRequest | undefined {
  const tools = request.tools ?? [];
  if (!(error instanceof CursorBuiltinToolCallError) || !choiceRequiresTool(request)) {
    return undefined;
  }
  if (tools.length === 0) return undefined;
  const exactName =
    typeof request.tool_choice === 'object' ? request.tool_choice.function.name : undefined;
  const tool = exactName
    ? tools.find((candidate) => candidate.function.name === exactName)
    : tools.length === 1
      ? tools[0]
      : undefined;
  const names = tools.map((candidate) => candidate.function.name);
  return {
    ...request,
    messages: [
      ...request.messages,
      {
        role: 'user',
        content: tool
          ? `BUILTIN TOOL RECOVERY: Call exactly the declared external tool ${JSON.stringify(tool.function.name)}. Do not use a Cursor builtin as a substitute.`
          : `BUILTIN TOOL RECOVERY: Use only these declared external tools: ${JSON.stringify(names)}. Satisfy the original tool request without using a Cursor builtin as a substitute.`,
      },
    ],
    tool_choice: tool
      ? { type: 'function', function: { name: tool.function.name } }
      : request.tool_choice,
  };
}

export function choiceRequiresTool(request: ChatCompletionRequest): boolean {
  return request.tool_choice === 'required' || typeof request.tool_choice === 'object';
}

function mappedStreamEvent(
  event: CompletionStreamEvent,
  restoreToolName: (name: string) => string,
  responseIndex: (id: string) => number,
  request: ChatCompletionRequest,
): CompletionStreamEvent {
  const forbidden = () =>
    new CursorBackendError('Cursor returned a tool call forbidden by the current request');
  const allows = (name: string): boolean => {
    if (request.tool_choice === 'none') return false;
    if (!(request.tools ?? []).some((tool) => tool.function.name === name)) return false;
    return typeof request.tool_choice !== 'object' || request.tool_choice.function.name === name;
  };
  switch (event.type) {
    case 'thinking':
    case 'content':
    case 'done':
      return event;
    case 'tool_call_arguments_delta':
      if (request.tool_choice === 'none') throw forbidden();
      return { ...event, index: responseIndex(event.id) };
    case 'tool_call_start': {
      const name = restoreToolName(event.name);
      if (!allows(name)) throw forbidden();
      return {
        ...event,
        index: responseIndex(event.id),
        name,
      };
    }
    case 'tool_call_complete': {
      const name = restoreToolName(event.call.function.name);
      if (!allows(name)) throw forbidden();
      return {
        ...event,
        index: responseIndex(event.call.id),
        call: {
          ...event.call,
          function: { ...event.call.function, name },
        },
      };
    }
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
  const responseIndexes = new Map<string, number>();
  const responseIndex = (id: string): number => {
    const existing = responseIndexes.get(id);
    if (existing !== undefined) return existing;
    const index = responseIndexes.size;
    responseIndexes.set(id, index);
    return index;
  };
  const runMapped = async (candidateRequest: ChatCompletionRequest): Promise<RunOutcome> => {
    const mapped = mapCursorApiToolRequest(candidateRequest);
    const mappedEmit: RunEmitter | undefined = lifecycle.emit
      ? Object.assign(
          (event: CompletionStreamEvent) =>
            lifecycle.emit?.(
              mappedStreamEvent(event, mapped.restoreToolName, responseIndex, candidateRequest),
            ),
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

  let outcome: RunOutcome;
  try {
    outcome = await runMapped(request);
  } catch (error) {
    const recovery = builtinRecoveryRequest(request, error);
    if (!recovery || gate.delivered) throw error;
    traceRetry(lifecycle.trace, 'tool_validation');
    try {
      outcome = await runMapped(recovery);
    } catch (retryError) {
      if (!(retryError instanceof CursorBuiltinToolCallError)) throw retryError;
      const toolNames = recovery.tools?.map((tool) => tool.function.name) ?? [];
      throw new CursorBuiltinToolCallError(
        `Cursor repeatedly selected a builtin instead of required external tools ${JSON.stringify(toolNames)}; retry with tool_choice="auto" if external tools are optional`,
      );
    }
  }
  const policyCalls = enforceNativeToolChoice(outcome.toolCalls, request);
  if (
    policyCalls.length !== outcome.toolCalls.length ||
    policyCalls.some((call, index) => call.id !== outcome.toolCalls[index]?.id)
  ) {
    const policyError = new CursorBackendError(
      'Cursor returned a tool call forbidden by the current request',
    );
    options.onToolValidationFailure?.(outcome.toolCalls, policyError);
    throw policyError;
  }
  const cappedCalls = capToolCallsForRequest(request, outcome.toolCalls);
  if (cappedCalls.length !== outcome.toolCalls.length) {
    outcome = { ...outcome, toolCalls: cappedCalls };
  }
  if (outcome.toolCalls.length) {
    const failure = validateToolCallArguments(outcome.toolCalls, request.tools);
    if (failure) {
      const validationError = new ToolArgumentValidationError(failure);
      options.onToolValidationFailure?.(outcome.toolCalls, validationError);
      if (gate.delivered) throw validationError;
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
      if (retryFailure) {
        const retryError = new ToolArgumentValidationError(retryFailure);
        options.onToolValidationFailure?.(outcome.toolCalls, retryError);
        throw retryError;
      }
    }
  }
  if (choiceRequiresTool(request) && outcome.toolCalls.length === 0) {
    throw new CursorBackendError('Cursor did not return the required tool call');
  }
  for (const call of outcome.toolCalls) {
    lifecycle.emit?.({ type: 'tool_call_complete', index: responseIndex(call.id), call });
  }
  return outcome;
}
