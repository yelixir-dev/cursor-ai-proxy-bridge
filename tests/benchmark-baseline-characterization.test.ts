import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

interface BaselineTrial {
  lane: 'native' | 'yorha';
  passed: boolean;
  upstream_runs: number;
  failure_class: string | null;
}

describe('sealed task-6 baseline characterization', () => {
  it('records the untouched schema-valid failure without treating it as bridge proof', async () => {
    const baseline = JSON.parse(
      await readFile('.omo/evidence/cursor-composer-parity-benchmark/baseline-before.json', 'utf8'),
    ) as { verdict: string; trials: BaselineTrial[] };
    const yorha = baseline.trials.filter((trial) => trial.lane === 'yorha');

    expect(baseline.verdict).toBe('fail');
    expect(yorha).toHaveLength(88);
    expect(yorha.reduce((total, trial) => total + trial.upstream_runs, 0)).toBe(0);
    expect(yorha.some((trial) => trial.passed && trial.upstream_runs === 0)).toBe(true);
    expect(
      baseline.trials.filter((trial) =>
        ['lingering_descendant', 'timeout'].includes(trial.failure_class ?? ''),
      ),
    ).toHaveLength(6);
  });
});
