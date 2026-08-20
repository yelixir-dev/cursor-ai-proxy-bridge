import { EventEmitter } from 'node:events';
import type { UsageSource } from '../backend/types.js';
import { parseTraceRecord, type SanitizedBridgeTraceRecord } from './bridge-trace-record.js';
import type { TrialTraceJoin } from './types.js';

export { parseTraceRecord, type SanitizedBridgeTraceRecord } from './bridge-trace-record.js';

export interface TraceState {
  runOpens: number;
  retries?: number;
  retryReasons?: readonly string[];
  flips: number;
  activeBackend?: string | null;
  usageSource?: UsageSource;
  finalBackendState?: string | null;
  cancelled?: boolean;
  quiescent?: boolean;
}

export interface BridgeTraceScope {
  snapshot(): TraceState;
  waitForRunOpen(timeoutMs: number, signal?: AbortSignal): Promise<boolean>;
  waitForSynchronizedRunOpen(timeoutMs: number, signal?: AbortSignal): Promise<boolean>;
  subscribeBackendChange(listener: () => void): () => void;
  finish(synchronized?: boolean): Promise<TrialTraceJoin>;
}

function summarize(records: readonly SanitizedBridgeTraceRecord[]): TraceState {
  const terminal = records.filter((record) => record.stage === 'terminal').at(-1);
  const activeBackend =
    records.find((record) => record.stage === 'backend' && record.backend !== null)?.backend ??
    records.find((record) => record.stage === 'run_open' && record.backend !== null)?.backend ??
    null;
  const latestBackend = records.filter((record) => record.backend !== null).at(-1)?.backend ?? null;
  const retryReasons = records.flatMap((record) =>
    record.stage === 'retry' && record.retry_kind ? [record.retry_kind] : [],
  );
  return {
    runOpens: records.filter((record) => record.stage === 'run_open').length,
    retries: retryReasons.length,
    retryReasons,
    flips: records.filter(
      (record) =>
        record.stage === 'backend_flip' ||
        (record.stage === 'run_open' && record.backend !== 'cursor-api'),
    ).length,
    activeBackend,
    usageSource: terminal?.usage_source ?? 'unknown',
    finalBackendState: terminal?.final_backend_state ?? latestBackend,
    cancelled: terminal?.cancelled ?? false,
    quiescent: terminal?.quiescent ?? false,
  };
}

export class BridgeTraceCollector {
  readonly #events = new EventEmitter();
  readonly #records: SanitizedBridgeTraceRecord[] = [];

  ingestValue(value: unknown): void {
    const record = parseTraceRecord(value, this.#records.length + 1);
    if (!record) return;
    this.#records.push(record);
    this.#events.emit('record', record);
  }

  ingest(line: string): void {
    if (!line.trim()) return;
    try {
      this.ingestValue(JSON.parse(line) as unknown);
    } catch {
      // Non-JSON bridge diagnostics are not benchmark trace evidence.
    }
  }

  snapshot(): TraceState {
    return summarize(this.#records);
  }

  records(): SanitizedBridgeTraceRecord[] {
    return this.#records.map((record) => ({ ...record }));
  }

  private waitForSynchronizedRunOpen(
    firstSequence: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return new Promise<boolean>((resolveRun) => {
      const finish = (found: boolean): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.#events.removeListener('record', onRecord);
        resolveRun(found);
      };
      const onAbort = (): void => finish(false);
      const onRecord = (record: SanitizedBridgeTraceRecord): void => {
        if (record.sequence > firstSequence && record.stage === 'run_open') finish(true);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      timer.unref?.();
      this.#events.on('record', onRecord);
      if (
        this.#records.some(
          (record) => record.sequence > firstSequence && record.stage === 'run_open',
        )
      ) {
        finish(true);
      } else if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  beginScope(): BridgeTraceScope {
    const firstSequence = this.#records.length;
    const scoped = () => this.#records.filter((record) => record.sequence > firstSequence);
    return {
      snapshot: () => summarize(scoped()),
      waitForSynchronizedRunOpen: (timeoutMs, signal) =>
        this.waitForSynchronizedRunOpen(firstSequence, timeoutMs, signal),
      subscribeBackendChange: (listener) => {
        let notified = false;
        const onRecord = (record: SanitizedBridgeTraceRecord): void => {
          if (notified || record.sequence <= firstSequence || record.stage !== 'backend_flip')
            return;
          notified = true;
          listener();
        };
        this.#events.on('record', onRecord);
        const existing = scoped().some((record) => record.stage === 'backend_flip');
        if (existing) {
          notified = true;
          listener();
        }
        return () => this.#events.removeListener('record', onRecord);
      },
      finish: async (synchronized = true) => {
        const records = scoped();
        const requestIds = [...new Set(records.map((record) => record.request_id))];
        const state = summarize(records);
        return {
          sequence_start: records[0]?.sequence ?? null,
          sequence_end: records.at(-1)?.sequence ?? null,
          request_ids: requestIds,
          record_count: records.length,
          attributed_run_count: state.runOpens,
          retry_count: state.retries ?? 0,
          retry_reasons: [...(state.retryReasons ?? [])],
          active_backend: state.activeBackend ?? null,
          usage_source: state.usageSource ?? 'unknown',
          final_backend_state: state.finalBackendState ?? null,
          cancelled: state.cancelled ?? false,
          quiescent: state.quiescent ?? false,
          synchronized,
        };
      },
      waitForRunOpen: (timeoutMs, signal) =>
        new Promise<boolean>((resolveRun) => {
          const finish = (found: boolean): void => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            this.#events.removeListener('record', onRecord);
            resolveRun(found);
          };
          const onAbort = (): void => finish(false);
          const onRecord = (record: SanitizedBridgeTraceRecord): void => {
            if (record.sequence > firstSequence && record.stage === 'run_open') finish(true);
          };
          const timer = setTimeout(() => finish(false), timeoutMs);
          timer.unref?.();
          this.#events.on('record', onRecord);
          if (scoped().some((record) => record.stage === 'run_open')) finish(true);
          else if (signal?.aborted) onAbort();
          else signal?.addEventListener('abort', onAbort, { once: true });
        }),
    };
  }
}
