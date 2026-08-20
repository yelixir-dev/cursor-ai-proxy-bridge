import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionTranscriptSummary } from './child-trace.js';

const MAX_SESSION_FILES = 64;
const MAX_SESSION_LINES = 20_000;
const OVERFLOW_KEY = '__other__';
const ENTRY_KINDS = new Set([
  'session',
  'session_info',
  'model_change',
  'thinking_level_change',
  'custom',
  'custom_message',
  'message',
]);
const STOP_REASONS = new Set([
  'stop',
  'length',
  'toolUse',
  'tool_use',
  'error',
  'aborted',
  'cancelled',
]);

export type SessionSummaryErrorCode = 'read_directory' | 'read_file' | 'malformed_jsonl';

export class SessionSummaryError extends Error {
  readonly name = 'SessionSummaryError';

  constructor(
    readonly code: SessionSummaryErrorCode,
    options: { readonly cause?: unknown } = {},
  ) {
    super(`session summary failed: ${code}`, { cause: options.cause });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function parseEntry(line: string): Record<string, unknown> {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch (cause) {
    throw new SessionSummaryError('malformed_jsonl', { cause });
  }
  if (!isRecord(entry)) throw new SessionSummaryError('malformed_jsonl');
  return entry;
}

export async function summarizeSessionDirectory(
  sessionDir: string,
): Promise<SessionTranscriptSummary | null> {
  let names: string[];
  try {
    names = (await readdir(sessionDir)).filter((name) => name.endsWith('.jsonl')).sort();
  } catch (cause) {
    throw new SessionSummaryError('read_directory', { cause });
  }
  if (names.length === 0) return null;
  const summary: SessionTranscriptSummary = {
    entry_kinds: {},
    assistant_stop_reasons: {},
    errored_assistant_messages: 0,
    user_messages: 0,
  };
  let entries = 0;
  for (const name of names.slice(0, MAX_SESSION_FILES)) {
    let contents: string;
    try {
      contents = await readFile(join(sessionDir, name), 'utf8');
    } catch (cause) {
      throw new SessionSummaryError('read_file', { cause });
    }
    for (const line of contents.split('\n')) {
      if (line.trim().length === 0) continue;
      entries += 1;
      if (entries > MAX_SESSION_LINES) return summary;
      const entry = parseEntry(line);
      const rawKind = text(entry.kind) || text(entry.type);
      const kind = ENTRY_KINDS.has(rawKind) ? rawKind : OVERFLOW_KEY;
      const bucket =
        kind in summary.entry_kinds || Object.keys(summary.entry_kinds).length < 128
          ? kind
          : OVERFLOW_KEY;
      summary.entry_kinds[bucket] = (summary.entry_kinds[bucket] ?? 0) + 1;
      const message = isRecord(entry.message) ? entry.message : undefined;
      if (!message) continue;
      const role = text(message.role);
      const rawStopReason = text(message.stopReason);
      const stopReason = STOP_REASONS.has(rawStopReason)
        ? rawStopReason
        : rawStopReason
          ? OVERFLOW_KEY
          : '';
      const errorMessage = text(message.errorMessage);
      if (role === 'assistant' || stopReason || errorMessage) {
        if (stopReason) {
          summary.assistant_stop_reasons[stopReason] =
            (summary.assistant_stop_reasons[stopReason] ?? 0) + 1;
        }
        if (stopReason === 'error' || errorMessage) summary.errored_assistant_messages += 1;
      }
      if (role === 'user') summary.user_messages += 1;
    }
  }
  return summary;
}
