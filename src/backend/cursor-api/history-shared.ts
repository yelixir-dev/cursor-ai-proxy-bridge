import { createHash } from 'node:crypto';
import type { ToolCall } from '../types.js';
import { ToolHistoryValidationError } from '../tool-history.js';

/** History is rebuilt from one OpenAI request at a time; blobs never persist. */
export class CursorBlobStore {
  readonly entries = new Map<string, Buffer>();

  store(bytes: Buffer): Buffer {
    const id = createHash('sha256').update(bytes).digest();
    this.entries.set(id.toString('hex'), bytes);
    return id;
  }
}

export function parsedArguments(call: ToolCall): Record<string, unknown> {
  const raw = call.function.arguments.trim();
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ToolHistoryValidationError(
      `Tool call ${call.id} arguments for ${call.function.name} are not a JSON object`,
    );
  }
  return parsed as Record<string, unknown>;
}

export function deterministicUuid(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
