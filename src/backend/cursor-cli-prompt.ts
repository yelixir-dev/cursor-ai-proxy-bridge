import type { ChatCompletionRequest, ToolCall } from './types.js';
import {
  filterToolCallsToAllowed,
  parseToolCallsFromText,
  toolDelegationPromptSuffix,
} from './tool-call-parse.js';
import type { ToolArgumentValidationFailure } from './tool-arguments.js';

export function promptFromMessages(request: ChatCompletionRequest): string {
  const toolsBlock =
    request.tool_choice === 'none'
      ? ''
      : toolDelegationPromptSuffix(request.tools, {
          toolChoice: request.tool_choice,
          parallelToolCalls: request.parallel_tool_calls,
        });
  const messages = request.messages
    .map((message) => {
      if (message.role === 'tool') {
        return `TOOL RESULT (call_id=${message.tool_call_id ?? 'unknown'}): ${message.content}`;
      }
      const promptRole = message.role === 'developer' ? 'system' : message.role;
      let line = `${promptRole.toUpperCase()}: ${message.content}`;
      if (message.tool_calls && message.tool_calls.length > 0) {
        line += `\n[TOOL_CALLS: ${JSON.stringify(message.tool_calls)}]`;
      }
      return line;
    })
    .join('\n\n');
  const toolChoiceNote =
    request.tool_choice && request.tool_choice !== 'none'
      ? `\n\nTool choice mode: ${typeof request.tool_choice === 'string' ? request.tool_choice : `force:${request.tool_choice.function.name}`}`
      : '';
  return toolsBlock + messages + toolChoiceNote;
}

export function parseCursorToolCallOutput(
  output: string,
  request: ChatCompletionRequest,
): ToolCall[] {
  let allowed = filterToolCallsToAllowed(parseToolCallsFromText(output), request.tools);
  const forcedName =
    typeof request.tool_choice === 'object' ? request.tool_choice.function.name : undefined;
  if (forcedName) allowed = allowed.filter((call) => call.function.name === forcedName);
  return request.parallel_tool_calls === false ? allowed.slice(0, 1) : allowed;
}

export function choiceRequiresToolCall(request: ChatCompletionRequest): boolean {
  return request.tool_choice === 'required' || typeof request.tool_choice === 'object';
}

export function toolValidationFeedback(failure: ToolArgumentValidationFailure): string {
  return `\n\n--- TOOL ARGUMENT VALIDATION FEEDBACK ---\nYour previous call to ${JSON.stringify(failure.toolName)} was invalid: ${failure.message}. Return a corrected tool call whose arguments match the declared schema.\n--- END TOOL ARGUMENT VALIDATION FEEDBACK ---`;
}
