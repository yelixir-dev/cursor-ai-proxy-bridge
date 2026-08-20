export interface SessionTranscriptSummary {
  entry_kinds: Record<string, number>;
  assistant_stop_reasons: Record<string, number>;
  errored_assistant_messages: number;
  user_messages: number;
}

export interface ChildExit {
  code: number | null;
  signal: string | null;
}

export interface TrialChildTrace {
  diagnostics: string;
  exits: ChildExit[];
  session: SessionTranscriptSummary | null;
}

export interface ChildResultLike {
  diagnostics: string;
  exit: { code: number | null; signal: NodeJS.Signals | null };
  session: SessionTranscriptSummary | null;
}

const MAX_DIAGNOSTIC_LINES = 64;
const MAX_DIAGNOSTIC_LINE_LENGTH = 256;
const MAX_DIAGNOSTIC_LENGTH = 4_096;
const MAX_HISTOGRAM_KEYS = 128;
const OVERFLOW_KEY = '__other__';

export function emptyTrialChild(): TrialChildTrace {
  return { diagnostics: '', exits: [], session: null };
}

export function boundDiagnostics(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .slice(0, MAX_DIAGNOSTIC_LINES)
    .map((line) => line.slice(0, MAX_DIAGNOSTIC_LINE_LENGTH));
  return lines.join('\n').slice(0, MAX_DIAGNOSTIC_LENGTH);
}

function bump(record: Record<string, number>, key: string): void {
  const bucket =
    key in record || Object.keys(record).length < MAX_HISTOGRAM_KEYS ? key : OVERFLOW_KEY;
  record[bucket] = (record[bucket] ?? 0) + 1;
}

export function mergeSessionSummaries(
  sessions: readonly (SessionTranscriptSummary | null)[],
): SessionTranscriptSummary | null {
  const present = sessions.filter(
    (session): session is SessionTranscriptSummary => session !== null,
  );
  if (present.length === 0) return null;
  const merged: SessionTranscriptSummary = {
    entry_kinds: {},
    assistant_stop_reasons: {},
    errored_assistant_messages: 0,
    user_messages: 0,
  };
  for (const session of present) {
    for (const [kind, count] of Object.entries(session.entry_kinds)) {
      for (let index = 0; index < count; index += 1) bump(merged.entry_kinds, kind);
    }
    for (const [reason, count] of Object.entries(session.assistant_stop_reasons)) {
      for (let index = 0; index < count; index += 1) bump(merged.assistant_stop_reasons, reason);
    }
    merged.errored_assistant_messages += session.errored_assistant_messages;
    merged.user_messages += session.user_messages;
  }
  return merged;
}

export function trialChildFromResults(results: readonly ChildResultLike[]): TrialChildTrace {
  const lines = [
    ...new Set(
      results.flatMap((result) => boundDiagnostics(result.diagnostics).split('\n').filter(Boolean)),
    ),
  ].slice(0, MAX_DIAGNOSTIC_LINES);
  return {
    diagnostics: boundDiagnostics(lines.join('\n')),
    exits: results.map((result) => ({ code: result.exit.code, signal: result.exit.signal })),
    session: mergeSessionSummaries(results.map((result) => result.session)),
  };
}
