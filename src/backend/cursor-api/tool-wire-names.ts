import type { ChatCompletionRequest, ToolCall } from '../types.js';

/** Called on tools after mapCursorApiToolRequest adds the virtual server prefix. */
export function rawCursorApiToolName(name: string): string {
  return name.replace(/^bridge-/, '');
}

function mapToolCallName(call: ToolCall, names: ReadonlyMap<string, string>): ToolCall {
  const name = names.get(call.function.name);
  if (!name) return call;
  return { ...call, function: { ...call.function, name } };
}

export interface CursorApiToolRequestMapping {
  request: ChatCompletionRequest;
  restoreToolName(name: string): string;
  restoreToolCalls(calls: readonly ToolCall[]): ToolCall[];
}

export function mapCursorApiToolRequest(
  request: ChatCompletionRequest,
): CursorApiToolRequestMapping {
  if (!request.tools?.length) {
    return {
      request,
      restoreToolName: (name) => name,
      restoreToolCalls: (calls) => [...calls],
    };
  }

  const toWire = new Map<string, string>();
  const toOpenAi = new Map<string, string>();
  const tools = request.tools.map((tool) => {
    const wireName = `bridge-${tool.function.name}`;
    toWire.set(tool.function.name, wireName);
    toOpenAi.set(wireName, tool.function.name);
    return { ...tool, function: { ...tool.function, name: wireName } };
  });
  const messages = request.messages.map((message) =>
    message.tool_calls
      ? {
          ...message,
          tool_calls: message.tool_calls.map((call) => mapToolCallName(call, toWire)),
        }
      : message,
  );
  const requestedToolChoice =
    request.tool_choice === 'required' && request.tools.length === 1
      ? {
          type: 'function' as const,
          function: { name: request.tools[0]?.function.name ?? '' },
        }
      : request.tool_choice;
  const toolChoice =
    typeof requestedToolChoice === 'object'
      ? {
          ...requestedToolChoice,
          function: {
            ...requestedToolChoice.function,
            name:
              toWire.get(requestedToolChoice.function.name) ?? requestedToolChoice.function.name,
          },
        }
      : requestedToolChoice;
  return {
    request: {
      ...request,
      messages,
      tools,
      tool_choice: toolChoice,
    },
    restoreToolName: (name) => toOpenAi.get(name) ?? name,
    restoreToolCalls: (calls) => calls.map((call) => mapToolCallName(call, toOpenAi)),
  };
}
