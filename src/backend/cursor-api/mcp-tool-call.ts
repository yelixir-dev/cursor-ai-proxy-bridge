import { randomUUID } from 'node:crypto';
import type { ToolCall } from '../types.js';
import { protoValueToJson } from './protobuf.js';

type Dict = Record<string, unknown>;

function dict(value: unknown): Dict | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

export function mcpArgsToToolCall(args: Dict): ToolCall {
  const decoded = Object.fromEntries(
    Object.entries(dict(args.args) ?? {}).map(([key, value]) => [
      key,
      protoValueToJson(dict(value) ?? {}),
    ]),
  );
  const name = String(args.name || args.toolName || 'unknown_tool');
  return {
    id: String(args.toolCallId || `call_bridge_${randomUUID()}`),
    type: 'function',
    function: { name, arguments: JSON.stringify(decoded) },
  };
}
