import type { AccountComparability } from './account-comparability.js';
import type { CanonicalCaseId, FailureClass, MetricName, OwningLayer } from './types.js';

export interface OverheadRow {
  case_id: CanonicalCaseId;
  turns: number;
  raw_total_gap_ms: number;
  expected_openai_surface_cost_ms: number;
  residual_bridge_overhead_ms: number;
}

export interface FirstDivergence {
  gate_id: string;
  case_id: CanonicalCaseId;
  metric: MetricName | null;
  failure_class: FailureClass | null;
  owning_layer: OwningLayer;
}

export type CompanionKind = 'bridge_trace' | 'versions_environment' | 'command_exit' | 'cleanup';

export interface CompanionFileReference {
  kind: CompanionKind;
  path: string;
}

export interface BenchmarkCompanions {
  files: CompanionFileReference[];
  account_mismatch: boolean;
  latency_confounded: boolean;
  account_comparability: AccountComparability;
}
