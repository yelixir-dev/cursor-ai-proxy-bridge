import type { AccountComparability } from './account-comparability.js';
import type { ResidualOverhead } from './statistics.js';
import type {
  BenchmarkCompanions,
  BenchmarkGate,
  CompanionFileReference,
  FirstDivergence,
  OverheadRow,
  TrialRecord,
} from './types.js';

export function companionFiles(baseName = 'composer-parity'): CompanionFileReference[] {
  return [
    { kind: 'bridge_trace', path: `${baseName}.bridge-trace.jsonl` },
    {
      kind: 'versions_environment',
      path: `${baseName}.versions-environment.json`,
    },
    { kind: 'command_exit', path: `${baseName}.command-exit.json` },
    { kind: 'cleanup', path: `${baseName}.cleanup.json` },
  ];
}

export function benchmarkCompanions(
  files: readonly CompanionFileReference[] | undefined,
  accountComparability: AccountComparability,
): BenchmarkCompanions {
  return {
    files: (files ?? companionFiles()).map((file) => ({ ...file })),
    account_mismatch: accountComparability.account_mismatch,
    latency_confounded: accountComparability.latency_confounded,
    account_comparability: { ...accountComparability },
  };
}

export function overheadRows(residuals: readonly ResidualOverhead[]): OverheadRow[] {
  return residuals.map((entry) => ({
    case_id: entry.case_id,
    turns: entry.turns,
    raw_total_gap_ms: entry.raw_gap_ms,
    expected_openai_surface_cost_ms: entry.surface_envelope_ms,
    residual_bridge_overhead_ms: entry.residual_ms,
  }));
}

export function firstDivergences(
  gates: readonly BenchmarkGate[],
  trials: readonly TrialRecord[],
): FirstDivergence[] {
  return gates
    .filter(
      (
        gate,
      ): gate is BenchmarkGate & {
        case_id: NonNullable<BenchmarkGate['case_id']>;
      } => gate.status === 'fail' && gate.case_id !== null,
    )
    .map((gate) => {
      const trial = trials.find(
        (candidate) => candidate.case_id === gate.case_id && !candidate.passed,
      );
      return {
        gate_id: gate.id,
        case_id: gate.case_id,
        metric: gate.metric,
        failure_class: trial?.failure_class ?? null,
        owning_layer: trial?.owning_layer ?? 'openai_surface_tax',
      };
    });
}
