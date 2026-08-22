import type { ChatCompletionRequest, CompletionResult, CompletionUsage } from '../backend/types.js';
import { ToolArgumentValidationError } from '../backend/tool-arguments.js';
import { CursorBackendError } from '../backend/cursor-cli.js';

export function openAiError(message: string, type = 'invalid_request_error', requestId?: string) {
  return { error: { message, type, ...(requestId ? { request_id: requestId } : {}) } };
}

export function backendErrorMessage(error: unknown): string {
  return error instanceof ToolArgumentValidationError || error instanceof CursorBackendError
    ? error.message
    : 'Cursor backend completion failed';
}

export function toolConfigurationError(request: ChatCompletionRequest): string | undefined {
  const tools = request.tools ?? [];
  const names = new Set(tools.map((tool) => tool.function.name));
  const choice = request.tool_choice;
  if ((choice === 'required' || typeof choice === 'object') && tools.length === 0) {
    return 'Required tool selection requires at least one defined tool';
  }
  if (names.size !== tools.length) return 'Duplicate tool function names are not allowed';
  if (typeof choice === 'object' && !names.has(choice.function.name)) {
    return `Requested tool is not defined: ${choice.function.name}`;
  }
  return undefined;
}

export function chatCompletionPayload(
  result: CompletionResult,
  id: string,
  created: number,
): Record<string, unknown> {
  const message: Record<string, unknown> = { role: 'assistant' };
  if (result.tool_calls && result.tool_calls.length > 0) {
    message.tool_calls = result.tool_calls;
    message.content = '';
  } else {
    message.content = result.content;
  }
  return {
    id,
    object: 'chat.completion',
    created,
    model: result.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: result.tool_calls?.length ? 'tool_calls' : 'stop',
      },
    ],
    usage: result.usage ?? {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}

export function completionChunk(
  request: ChatCompletionRequest,
  id: string,
  created: number,
  choices: readonly unknown[],
  usage?: CompletionUsage,
): Record<string, unknown> {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model: request.model,
    choices,
    ...(usage ? { usage } : {}),
  };
}

export function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}
