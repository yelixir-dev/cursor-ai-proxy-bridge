import { describe, expect, it } from 'vitest';
import { CompletionMetrics } from '../src/server/metrics.js';

describe('bounded completion counters', () => {
  it('measures completed latency using the supplied monotonic clock', () => {
    // Given one admitted request and a controllable clock.
    let now = 10;
    const metrics = new CompletionMetrics(() => now);
    const finish = metrics.start('composer-2.5', 'direct', false);
    expect(metrics.snapshot().series[0]).toMatchObject({
      requests: 1,
      in_flight: 1,
      latency_ms: { count: 0, total: 0, average: 0 },
    });
    // When the request finishes 32 milliseconds later.
    now = 42;
    finish('success');
    // Then all duration values use the observed interval, without wall-clock waits.
    expect(metrics.snapshot().series[0]).toMatchObject({
      in_flight: 0,
      success: 1,
      latency_ms: { count: 1, total: 32, maximum: 32, average: 32 },
    });
  });

  it('settles each admitted request only once', () => {
    // Given a single admission.
    const metrics = new CompletionMetrics(() => 0);
    const finish = metrics.start('composer-2.5', 'litellm', true);
    // When multiple lifecycle notifications attempt to settle it.
    finish('success');
    finish('error');
    // Then the original terminal outcome is not double-counted.
    expect(metrics.snapshot().series[0]).toMatchObject({
      requests: 1,
      in_flight: 0,
      success: 1,
      backend_error: 0,
      latency_ms: { count: 1 },
    });
  });

  it('bounds retained model labels while keeping overflow counts', () => {
    // Given a process with a two-model label budget.
    const metrics = new CompletionMetrics(() => 0, 2);
    // When more unique models finish requests than the label budget permits.
    for (let index = 0; index < 100; index += 1) {
      metrics.start(`model-${index}`, 'direct', false)('error');
    }
    // Then excess labels collapse into one aggregate without losing outcomes.
    const snapshot = metrics.snapshot();
    expect(snapshot.tracked_models).toBe(2);
    expect(snapshot.series).toHaveLength(3);
    expect(snapshot.series.find((series) => series.model === '__other__')).toMatchObject({
      requests: 98,
      backend_error: 98,
      in_flight: 0,
    });
  });

  it.each([
    { outcome: 'abort', expected: { aborted: 1, rate_limited: 0 } },
    {
      outcome: 'rate_limited',
      expected: { aborted: 0, rate_limited: 1 },
    },
  ] as const)('distinguishes $outcome from a backend failure', ({ outcome, expected }) => {
    // Given an admitted request.
    const metrics = new CompletionMetrics(() => 0);
    const finish = metrics.start('composer-2.5', undefined, false);
    // When its explicit terminal state is known.
    finish(outcome);
    // Then cancellation and admission rejection do not become backend failures.
    expect(metrics.snapshot().series[0]).toMatchObject({
      ...expected,
      route: 'unknown',
      success: 0,
      backend_error: 0,
      in_flight: 0,
    });
  });
});
