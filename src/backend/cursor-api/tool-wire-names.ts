import type { ChatCompletionRequest, ToolCall } from '../types.js';

const WIRE_NAME_PREFIX = 'bridge_tool';
const WIRE_NAME_SUFFIX_LENGTH = 120;

function wireToolName(name: string, index: number): string {
  const suffix = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, WIRE_NAME_SUFFIX_LENGTH) || 'tool';
  return `${WIRE_NAME_PREFIX}_${index}_${suffix}`;
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
  const tools = request.tools.map((tool, index) => {
    const wireName = wireToolName(tool.function.name, index);
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
    (request.tool_choice === 'required' ||
      (request.tool_choice === 'auto' && request.max_tool_calls === 1)) &&
    request.tools.length === 1
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
  const aliasInstruction =
    request.tool_choice === 'none'
      ? []
      : [
          {
            role: 'developer' as const,
            content: `External OpenAI tool aliases: ${JSON.stringify(Object.fromEntries(toWire))}. If you choose or are required to call an original tool, call its mapped external tool and never a built-in tool as a substitute.`,
          },
        ];

  return {
    request: {
      ...request,
      messages: [...aliasInstruction, ...messages],
      tools,
      tool_choice: toolChoice,
    },
    restoreToolName: (name) => toOpenAi.get(name) ?? name,
    restoreToolCalls: (calls) => calls.map((call) => mapToolCallName(call, toOpenAi)),
  };
}
