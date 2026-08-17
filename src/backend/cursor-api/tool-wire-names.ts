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
  restoreToolCalls(calls: readonly ToolCall[]): ToolCall[];
}

export function mapCursorApiToolRequest(
  request: ChatCompletionRequest,
): CursorApiToolRequestMapping {
  if (!request.tools?.length) {
    return { request, restoreToolCalls: (calls) => [...calls] };
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
  const toolChoice =
    typeof request.tool_choice === 'object'
      ? {
          ...request.tool_choice,
          function: {
            ...request.tool_choice.function,
            name:
              toWire.get(request.tool_choice.function.name) ?? request.tool_choice.function.name,
          },
        }
      : request.tool_choice;
  const aliases = Object.fromEntries(toWire);
  const aliasInstruction = {
    role: 'developer' as const,
    content: `External OpenAI tool aliases: ${JSON.stringify(aliases)}. When a request names an original tool, call its mapped external tool and never a built-in tool with the original name.`,
  };

  return {
    request: {
      ...request,
      messages: [aliasInstruction, ...messages],
      tools,
      tool_choice: toolChoice,
    },
    restoreToolCalls: (calls) => calls.map((call) => mapToolCallName(call, toOpenAi)),
  };
}
