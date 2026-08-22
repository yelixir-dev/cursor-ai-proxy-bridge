import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TraceStage } from '../trace.js';

const TRACE_STAGES: ReadonlySet<string> = new Set<TraceStage>([
  'accepted',
  'queue_acquired',
  'backend',
  'run_open',
  'h2_session_connect',
  'run_stream_open',
  'first_event',
  'tool_decision',
  'tool_batch_complete',
  'retry',
  'terminal',
  'abort',
  'backend_flip',
]);

export interface E2eTraceReceipt {
  schema_version: 'cursor-e2e-trace-receipt/v1';
  trace_path: string;
  trace_sha256: string;
  record_count: number;
  stage_counts: Record<string, number>;
  request_id_count: number;
  run_open_count: number;
  retained: boolean;
}

export type SanitizedTraceRecord = Readonly<Record<string, unknown>>;
export type TraceRecordMatcher = (record: SanitizedTraceRecord) => boolean;

export interface E2eTraceProvenance {
  readonly root: string;
  readonly tracePath: string;
  readonly receiptPath: string;
  ingest(line: string): void;
  waitForRecord(match: TraceRecordMatcher, signal: AbortSignal): Promise<SanitizedTraceRecord>;
  finish(options: { failed: boolean }): Promise<E2eTraceReceipt>;
}

export interface AbortQuiescenceOptions {
  readonly provenance: E2eTraceProvenance;
  readonly signal: AbortSignal;
  readonly trigger: () => Promise<void>;
}

export class TraceSubscriptionAbortedError extends Error {
  readonly name = 'TraceSubscriptionAbortedError';
}

interface TraceSubscription {
  readonly match: TraceRecordMatcher;
  readonly resolve: (record: SanitizedTraceRecord) => void;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
}

export async function triggerAndAwaitAbortQuiescence(
  options: AbortQuiescenceOptions,
): Promise<SanitizedTraceRecord> {
  const observed = options.provenance.waitForRecord(
    (record) =>
      record.stage === 'terminal' && record.terminal === 'abort' && record.quiescent === true,
    options.signal,
  );
  const [record] = await Promise.all([observed, options.trigger()]);
  return record;
}

/**
 * Server child environment for the pinned E2E harness. Bridge tracing is always
 * enabled so any future failure keeps per-stage chronology on stderr; scenario
 * assertions, timeouts, and retry semantics are untouched.
 */
export function serverEnvironment(
  baseEnv: NodeJS.ProcessEnv,
  overrides: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  return { ...baseEnv, ...overrides, CURSOR_BRIDGE_TRACE: '1' };
}

function scrubText(value: string): string {
  return value
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted-secret]');
}

function scrubValue(value: unknown): unknown {
  if (typeof value === 'string') return scrubText(value);
  if (Array.isArray(value)) return value.map(scrubValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrubValue(item)]));
  }
  return value;
}

/**
 * Parses one bridge stderr line into a sanitized trace record, or null when the
 * line is not a bridge trace record. Keeps only records whose stage belongs to
 * the shipped trace stage set and whose request id is a string, then scrubs
 * secret-looking values from every field.
 */
export function sanitizeTraceLine(line: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.stage !== 'string' || !TRACE_STAGES.has(record.stage)) return null;
  if (typeof record.request_id !== 'string') return null;
  return scrubValue(record) as Record<string, unknown>;
}

export async function createTraceProvenance(
  options: { tempRoot?: string } = {},
): Promise<E2eTraceProvenance> {
  const root = await mkdtemp(join(options.tempRoot ?? tmpdir(), 'cursor-e2e-trace-'));
  const tracePath = join(root, 'bridge-trace.jsonl');
  const receiptPath = join(root, 'trace-receipt.json');
  const records: Record<string, unknown>[] = [];
  const subscriptions = new Set<TraceSubscription>();
  const removeSubscription = (subscription: TraceSubscription) => {
    subscriptions.delete(subscription);
    subscription.signal.removeEventListener('abort', subscription.onAbort);
  };
  return {
    root,
    tracePath,
    receiptPath,
    ingest(line) {
      const record = sanitizeTraceLine(line);
      if (!record) return;
      records.push(record);
      for (const subscription of [...subscriptions]) {
        if (!subscription.match(record)) continue;
        removeSubscription(subscription);
        subscription.resolve(record);
      }
    },
    waitForRecord(match, signal) {
      return new Promise((resolveRecord, reject) => {
        const onAbort = () => {
          removeSubscription(subscription);
          reject(new TraceSubscriptionAbortedError('trace subscription aborted'));
        };
        const subscription = {
          match,
          resolve: resolveRecord,
          signal,
          onAbort,
        };
        if (signal.aborted) {
          reject(new TraceSubscriptionAbortedError('trace subscription aborted'));
          return;
        }
        subscriptions.add(subscription);
        signal.addEventListener('abort', onAbort, { once: true });
      });
    },
    async finish({ failed }) {
      const stageCounts: Record<string, number> = {};
      for (const record of records) {
        const stage = record.stage;
        if (typeof stage !== 'string') continue;
        stageCounts[stage] = (stageCounts[stage] ?? 0) + 1;
      }
      const traceText = records.map((record) => JSON.stringify(record)).join('\n');
      await writeFile(tracePath, traceText ? `${traceText}\n` : '');
      const receipt: E2eTraceReceipt = {
        schema_version: 'cursor-e2e-trace-receipt/v1',
        trace_path: tracePath,
        trace_sha256: createHash('sha256').update(`${traceText}\n`).digest('hex'),
        record_count: records.length,
        stage_counts: stageCounts,
        request_id_count: new Set(records.map((record) => record.request_id)).size,
        run_open_count: stageCounts.run_open ?? 0,
        retained: failed,
      };
      await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
      if (!failed) await rm(root, { recursive: true, force: true });
      return receipt;
    },
  };
}
