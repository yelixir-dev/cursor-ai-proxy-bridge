import { describe, expect, it } from 'vitest';
import { BridgeTraceCollector, parseTraceRecord } from '../src/benchmark/bridge-trace.js';

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

  it('retains typed provider errors and retry telemetry at the benchmark boundary', () => {
    const upstreamError = record('upstream_error', {
      upstream_error_code: 'resource_exhausted',
      upstream_error_type: 'ERROR_PROVIDER_ERROR',
      upstream_retryable: true,
      provider_status_code: '503',
      run_request_id: 'run-provider-123',
      retry_declined: 'flag_off',
      retry_provider_5xx: true,
    });
    expect(parseTraceRecord(upstreamError, 7)).toEqual({
      sequence: 7,
      ...upstreamError,
    });

    expect(
      parseTraceRecord(
        record('retry', {
          upstream_run_count: 1,
          retry_count: 1,
          retry_kind: 'server',
          retry_reason: 'provider_5xx',
        }),
        8,
      ),
    ).toMatchObject({
      sequence: 8,
      stage: 'retry',
      retry_kind: 'server',
      retry_reason: 'provider_5xx',
    });

    expect(
      parseTraceRecord(
        record('credential_failover', {
          credential_slot_id: 'slot_1111111111111111',
          excluded_credential_slot_id: 'slot_1111111111111111',
          credential_exclusion_reason: 'cooldown',
          next_credential_slot_id: 'slot_2222222222222222',
        }),
        9,
      ),
    ).toMatchObject({
      sequence: 9,
      stage: 'credential_failover',
      excluded_credential_slot_id: 'slot_1111111111111111',
      credential_exclusion_reason: 'cooldown',
      next_credential_slot_id: 'slot_2222222222222222',
    });
  });

  it('rejects malformed provider and retry telemetry values or unknown keys', () => {
    const base = record('upstream_error', {
      upstream_error_code: 'resource_exhausted',
      upstream_error_type: 'ERROR_PROVIDER_ERROR',
      upstream_retryable: true,
      provider_status_code: '503',
      run_request_id: 'run-provider-123',
      retry_declined: 'flag_off',
      retry_provider_5xx: true,
    });
    for (const [key, value] of [
      ['upstream_error_code', 'not safe/id'],
      ['upstream_error_type', 503],
      ['provider_status_code', '500 status'],
      ['run_request_id', ''],
      ['upstream_retryable', 'true'],
      ['retry_provider_5xx', 'true'],
      ['retry_declined', 'unknown'],
      ['retry_reason', 'server'],
      ['credential_exclusion_reason', 'quota'],
      ['excluded_credential_slot_id', 'raw credential id'],
      ['next_credential_slot_id', 'raw next id'],
      ['unexpected_trace_key', true],
    ] as const) {
      expect(parseTraceRecord({ ...base, [key]: value }, 1), key).toBeNull();
    }
  });
});
