export interface DiffDelta {
  type: string;
  kind?: string;
  capture?: 'a' | 'b';
  position?: number;
  position_a?: number;
  position_b?: number;
  only_in_a?: string[];
  only_in_b?: string[];
  value_mismatch?: string[];
  detail: string;
}

export interface LifecycleEventDelta {
  event: string;
  position_a: number;
  position_b: number;
  mono_ms_a: number | null;
  mono_ms_b: number | null;
  delta_ms: number | null;
}

export interface DiffReport {
  schema_version: number;
  identical: boolean;
  summary: {
    frames_a: number;
    frames_b: number;
    matched: number;
    missing: number;
    extra: number;
    delta_count: number;
  };
  deltas: DiffDelta[];
  lifecycle?: { events: LifecycleEventDelta[] };
}

export declare class DiffInputError extends Error {
  kind: string;
  constructor(kind: string, message: string);
}

export declare function diffCaptures(
  inputA: string,
  inputB: string,
  options?: { lifecycleA?: string; lifecycleB?: string },
): DiffReport;
