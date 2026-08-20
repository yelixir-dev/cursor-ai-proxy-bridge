import { describe, expect, it } from 'vitest';
import { BridgeTraceCollector } from '../src/benchmark/bridge-trace.js';

function record(stage: string, values: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    request_id: 'req-task-11-contract',
    credential_slot_id: null,
    backend: 'cursor-api',
    model: 'composer-2.5',
    upstream_run_count: stage === 'run_open' ? 2 : 0,
    retry_count: stage === 'retry' ? 1 : 0,
    stage,
    offset_ms: 1,
    ...values,
  };
}

describe('task 11 benchmark trace contract', () => {
  it('seals upstream Runs, retries, backend state, usage source, and quiescence into evidence', async () => {
    const collector = new BridgeTraceCollector();
    const scope = collector.beginScope();
    collector.ingestValue(record('backend'));
    collector.ingestValue(record('run_open', { upstream_run_count: 1 }));
    collector.ingestValue(record('retry', { upstream_run_count: 1, retry_kind: 'transport' }));
    collector.ingestValue(record('run_open'));
    collector.ingestValue(
      record('terminal', {
        upstream_run_count: 2,
        retry_count: 1,
        retry_kind: 'transport',
        usage_source: 'turnEnded',
        final_backend_state: 'cursor-api',
        cancelled: false,
        quiescent: true,
        terminal: 'success',
      }),
    );

    await expect(scope.finish()).resolves.toMatchObject({
      attributed_run_count: 2,
      retry_count: 1,
      retry_reasons: ['transport'],
      active_backend: 'cursor-api',
      usage_source: 'turnEnded',
      final_backend_state: 'cursor-api',
      cancelled: false,
      quiescent: true,
    });
  });

  it('does not accept a fabricated cursor-api estimated usage source', () => {
    const collector = new BridgeTraceCollector();
    collector.ingestValue(
      record('terminal', {
        usage_source: 'estimated',
        final_backend_state: 'cursor-api',
        cancelled: false,
        quiescent: true,
        terminal: 'success',
      }),
    );

    expect(collector.records()).toEqual([]);
  });
});
