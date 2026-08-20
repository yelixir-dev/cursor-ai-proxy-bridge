import type { UsageSource } from '../backend/types.js';

export interface TrialTraceJoin {
  sequence_start: number | null;
  sequence_end: number | null;
  request_ids: string[];
  record_count: number;
  attributed_run_count: number;
  retry_count?: number;
  retry_reasons?: string[];
  active_backend?: string | null;
  usage_source?: UsageSource;
  final_backend_state?: string | null;
  cancelled?: boolean;
  quiescent?: boolean;
  synchronized: boolean;
}
