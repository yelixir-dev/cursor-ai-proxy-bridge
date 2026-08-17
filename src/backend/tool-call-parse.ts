import { randomUUID } from 'node:crypto';
import type { Tool, ToolCall, ToolChoice } from './types.js';

interface UnknownToolPayload {
  id?: unknown;
  type?: unknown;
  name?: unknown;
  arguments?: unknown;
  args?: unknown;
  function?: { name?: unknown; arguments?: unknown; args?: unknown };
}

function callId(): string {
  return `call_bridge_${randomUUID()}`;
}

function normalizeArguments(raw: unknown): string {
  if (typeof raw === 'string') {
    JSON.parse(raw);
    return raw;
  }
  return JSON.stringify(raw && typeof raw === 'object' ? raw : {});
}

function normalizeToolCall(raw: unknown): ToolCall | undefined {
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
    id: typeof candidate.id === 'string' && candidate.id ? candidate.id : callId(),
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
  return rawCalls.flatMap((raw) => {
    const normalized = normalizeToolCall(raw);
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
          return parsed.flatMap((raw) => {
            const normalized = normalizeToolCall(raw);
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

export function filterToolCallsToAllowed(
  toolCalls: ToolCall[],
  tools: Tool[] | undefined,
): ToolCall[] {
  if (!tools || tools.length === 0) return [];
  const allowedTools = new Set(tools.map((tool) => tool.function.name));
  return toolCalls.filter((call) => allowedTools.has(call.function.name));
}

export interface ToolDelegationOptions {
  toolChoice?: ToolChoice;
  parallelToolCalls?: boolean;
}

export function toolDelegationPromptSuffix(
  tools: Tool[] | undefined,
  options: ToolDelegationOptions = {},
): string {
  if (!tools || tools.length === 0) return '';
  const defs = tools.map(
    (tool) =>
      `- ${tool.function.name}: ${tool.function.description ?? ''}\n  parameters: ${JSON.stringify(tool.function.parameters ?? {})}`,
  );
  const selection =
    typeof options.toolChoice === 'object'
      ? `You must call exactly the function named ${JSON.stringify(options.toolChoice.function.name)}.`
      : options.toolChoice === 'required'
        ? 'You must call one or more available tools.'
        : 'Call an available tool only when needed; otherwise answer normally.';
  const parallel =
    options.parallelToolCalls === false
      ? 'Return at most one tool call.'
      : 'For independent operations, you may return multiple tool calls.';
  return `\n\n--- AVAILABLE TOOLS ---\n${defs.join('\n')}\n--- END TOOLS ---\n\n--- TOOL CALL OUTPUT CONTRACT ---\nDelegate tool use to the OpenAI client instead of pretending to execute it. Do not execute the tool yourself. Respond with ONLY this exact text pattern and no prose when making calls:\n[TOOL_CALLS: [{"function":{"name":"tool_name","arguments":{}}}]]\nThe arguments object must match the selected tool schema. ${selection} ${parallel} Legacy marker for compatibility: CURSOR_BRIDGE_TOOL_CALL. Do not claim you used a tool in prose; emit the [TOOL_CALLS] block instead.\n--- END TOOL CALL OUTPUT CONTRACT ---\n`;
}
