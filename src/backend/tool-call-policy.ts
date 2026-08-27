import type { ChatCompletionRequest, Tool } from './types.js';

export function allowedToolsForRequest(request: ChatCompletionRequest): Tool[] {
  const tools = request.tools ?? [];
  const choice = request.tool_choice;
  if (choice === 'none') return [];
  if (typeof choice !== 'object') return tools;
  return tools.filter((tool) => tool.function.name === choice.function.name);
}

export function allowedToolNamesForRequest(request: ChatCompletionRequest): Set<string> {
  return new Set(allowedToolsForRequest(request).map((tool) => tool.function.name));
}

export function maximumToolCallsForRequest(request: ChatCompletionRequest): number {
  if (request.max_tool_calls !== undefined) return request.max_tool_calls;
  return request.parallel_tool_calls === false ? 1 : Number.POSITIVE_INFINITY;
}

export function capToolCallsForRequest<T>(
  request: ChatCompletionRequest,
  calls: readonly T[],
): T[] {
  const maximum = maximumToolCallsForRequest(request);
  return Number.isFinite(maximum) ? calls.slice(0, maximum) : [...calls];
}
