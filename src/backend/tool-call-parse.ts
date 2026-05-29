import type { Tool, ToolCall } from './types.js';

interface UnknownToolPayload {
  id?: unknown;
  type?: unknown;
  name?: unknown;
  arguments?: unknown;
  args?: unknown;
  function?: { name?: unknown; arguments?: unknown; args?: unknown };
}

function callId(index = 0): string {
  return `call_bridge_${Date.now().toString(36)}_${index}`;
}

function normalizeArguments(raw: unknown): string {
  if (typeof raw === 'string') {
    JSON.parse(raw);
    return raw;
  }
  return JSON.stringify(raw && typeof raw === 'object' ? raw : {});
}

function normalizeToolCall(raw: unknown, index = 0): ToolCall | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const candidate = raw as UnknownToolPayload;
  const name =
    typeof candidate.function?.name === 'string'
      ? candidate.function.name
      : typeof candidate.name === 'string'
        ? candidate.name
        : '';
  if (!name) return undefined;

  const rawArgs =
    candidate.function?.arguments ??
    candidate.function?.args ??
    candidate.arguments ??
    candidate.args ??
    {};
  let argumentsJson: string;
  try {
    argumentsJson = normalizeArguments(rawArgs);
  } catch {
    return undefined;
  }

  return {
    id: typeof candidate.id === 'string' && candidate.id ? candidate.id : callId(index),
    type: 'function',
    function: { name, arguments: argumentsJson },
  };
}

function parseToolCallsPayload(payload: unknown): ToolCall[] {
  if (!payload || typeof payload !== 'object') return [];
  const asObject = payload as { tool_calls?: unknown; function_call?: unknown };
  const rawCalls = Array.isArray(asObject.tool_calls)
    ? asObject.tool_calls
    : asObject.function_call
      ? [asObject.function_call]
      : [];
  return rawCalls.flatMap((raw, index) => {
    const normalized = normalizeToolCall(raw, index);
    return normalized ? [normalized] : [];
  });
}

function stripJsonFence(output: string): string {
  const trimmed = output.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenceMatch?.[1]?.trim() ?? trimmed;
}

function extractBracketedJson(text: string, openIndex: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = openIndex; i < text.length; i += 1) {
    const char = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '[' || char === '{') depth += 1;
    if (char === ']' || char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(openIndex, i + 1);
    }
  }
  return undefined;
}

export function parseToolCallsFromText(output: string): ToolCall[] {
  const marker = '[TOOL_CALLS:';
  const markerIndex = output.indexOf(marker);
  if (markerIndex >= 0) {
    const payloadStart = output.indexOf('[', markerIndex + marker.length);
    if (payloadStart >= 0) {
      const jsonText = extractBracketedJson(output, payloadStart);
      if (jsonText) {
        try {
          const parsed = JSON.parse(jsonText) as unknown[];
          return parsed.flatMap((raw, index) => {
            const normalized = normalizeToolCall(raw, index);
            return normalized ? [normalized] : [];
          });
        } catch {
          return [];
        }
      }
    }
    return [];
  }

  try {
    return parseToolCallsPayload(JSON.parse(stripJsonFence(output)));
  } catch {
    return [];
  }
}

function cursorToolNameToOpenAi(name: string): string | undefined {
  const mapping: Record<string, string> = {
    shellToolCall: 'terminal',
    readToolCall: 'read_file',
    writeToolCall: 'write_file',
    searchReplaceToolCall: 'patch',
    grepToolCall: 'search_files',
    listDirToolCall: 'search_files',
  };
  return mapping[name] ?? (name.endsWith('ToolCall') ? undefined : name);
}

export function mapCursorStreamToolCall(event: unknown): ToolCall | undefined {
  if (!event || typeof event !== 'object') return undefined;
  const candidate = event as {
    type?: unknown;
    subtype?: unknown;
    tool_call?: UnknownToolPayload;
    toolCall?: UnknownToolPayload;
    name?: unknown;
    id?: unknown;
    args?: unknown;
    input?: unknown;
  };
  if (candidate.subtype !== 'started') return undefined;
  const rawCall: UnknownToolPayload = candidate.tool_call ??
    candidate.toolCall ?? {
      id: candidate.id,
      name: candidate.name,
      args: candidate.args ?? candidate.input,
    };
  const rawName =
    typeof rawCall.name === 'string'
      ? rawCall.name
      : typeof rawCall.function?.name === 'string'
        ? rawCall.function.name
        : '';
  const name = cursorToolNameToOpenAi(rawName);
  if (!name) return undefined;
  const rawArgs = rawCall.args ?? rawCall.arguments ?? candidate.args ?? candidate.input ?? {};
  let argumentsJson: string;
  try {
    argumentsJson = normalizeArguments(rawArgs);
  } catch {
    return undefined;
  }
  return {
    id: typeof rawCall.id === 'string' && rawCall.id ? rawCall.id : callId(0),
    type: 'function',
    function: { name, arguments: argumentsJson },
  };
}

export function parseToolCallsFromCursorStreamJson(output: string): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const mapped = mapCursorStreamToolCall(JSON.parse(trimmed));
      if (mapped) calls.push(mapped);
    } catch {
      // Cursor may interleave non-JSON status lines; ignore them.
    }
  }
  return calls;
}

export function filterToolCallsToAllowed(
  toolCalls: ToolCall[],
  tools: Tool[] | undefined,
): ToolCall[] {
  if (!tools || tools.length === 0) return [];
  const allowedTools = new Set(tools.map((tool) => tool.function.name));
  return toolCalls.filter((call) => allowedTools.has(call.function.name));
}

export function toolDelegationPromptSuffix(tools: Tool[] | undefined): string {
  if (!tools || tools.length === 0) return '';
  const defs = tools.map(
    (tool) =>
      `- ${tool.function.name}: ${tool.function.description ?? ''}\n  parameters: ${JSON.stringify(tool.function.parameters ?? {})}`,
  );
  return `\n\n--- AVAILABLE TOOLS ---\n${defs.join('\n')}\n--- END TOOLS ---\n\n--- TOOL CALL OUTPUT CONTRACT ---\nIf the user request requires one of these tools, delegate to the OpenAI client instead of pretending to execute it. Do not execute the tool yourself. Respond with ONLY this exact text pattern and no prose:\n[TOOL_CALLS: [{"function":{"name":"tool_name","arguments":{}}}]]\nThe arguments object must match the selected tool schema. Legacy marker for compatibility: CURSOR_BRIDGE_TOOL_CALL. Do not claim you used a tool in prose; emit the [TOOL_CALLS] block instead.\n--- END TOOL CALL OUTPUT CONTRACT ---\n`;
}
