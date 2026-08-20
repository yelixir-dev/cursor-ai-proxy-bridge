import { sha256Hex, stableJson } from './hash-json.js';
export interface ObservedCall {
  name: string;
  callId: string;
  callIdHash: string;
  arguments: Record<string, unknown> | undefined;
  argumentsHash: string;
  valid: boolean;
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

function dict(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function readCall(raw: unknown, fallbackId: string): ObservedCall | undefined {
  const rec = dict(raw);
  if (!rec) return undefined;
  const fn = dict(rec.function) ?? rec;
  const name = textOf(fn.name ?? rec.name);
  if (!name && rec.arguments === undefined && fn.arguments === undefined) return undefined;
  let args: Record<string, unknown> | undefined;
  try {
    args = dict(
      typeof (fn.arguments ?? rec.arguments ?? fn.args) === 'string'
        ? JSON.parse(textOf(fn.arguments ?? rec.arguments ?? fn.args))
        : (fn.arguments ?? rec.arguments ?? fn.args),
    );
  } catch {
    args = undefined;
  }
  const callId = textOf(rec.id) || fallbackId;
  return {
    name,
    callId,
    callIdHash: sha256Hex(callId),
    arguments: args,
    argumentsHash: sha256Hex(args ? stableJson(args) : 'invalid'),
    valid: Boolean(name && NAME_RE.test(name) && args),
  };
}
