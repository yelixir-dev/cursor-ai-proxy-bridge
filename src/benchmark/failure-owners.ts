import type { FailureClass, OwningLayer } from './types.js';

const LAYER_GROUPS: ReadonlyArray<readonly [OwningLayer, readonly FailureClass[]]> = [
  ['model_variance', ['sentinel_mismatch']],
  [
    'tool_scheduling',
    [
      'hallucinated_tool',
      'substituted_builtin',
      'invalid_tool_args',
      'duplicate_tool_call',
      'missing_tool_call',
      'unexpected_tool',
      'tool_order_mismatch',
    ],
  ],
  ['request_history_mapper', ['tool_id_replay_mismatch', 'invalid_request_accepted']],
  ['stream_adapter', ['schema_recovery_failed']],
  ['transport', ['missing_terminal']],
  ['retry_cancel_lifecycle', ['late_after_abort', 'cancel_failed']],
  ['backend_routing', ['backend_flip']],
  [
    'infrastructure',
    ['rate_limit', 'quota', 'quota_stop', 'auth', 'transport', 'timeout', 'infra_fail'],
  ],
  [
    'harness',
    [
      'crosstalk',
      'prompt_mismatch',
      'malformed_jsonl',
      'stdout_overflow',
      'stderr_overflow',
      'evidence_io_failure',
      'early_exit',
      'lingering_descendant',
      'missing_model',
      'harness_version_mismatch',
      'harness_failure',
    ],
  ],
];

const OWNING_LAYER_BY_FAILURE = new Map<FailureClass, OwningLayer>(
  LAYER_GROUPS.flatMap(([layer, classes]) =>
    classes.map((failureClass) => [failureClass, layer] as const),
  ),
);
const QUOTA_STOP_FAILURES = new Set<FailureClass>(['rate_limit', 'quota']);
const INFRA_STOP_FAILURES = new Set<FailureClass>([
  'prompt_mismatch',
  'stdout_overflow',
  'stderr_overflow',
  'evidence_io_failure',
  'harness_version_mismatch',
  'backend_flip',
  'infra_fail',
]);

export function owningLayerFor(failureClass: FailureClass): OwningLayer {
  const layer = OWNING_LAYER_BY_FAILURE.get(failureClass);
  if (layer === undefined) throw new Error(`unmapped failure class: ${failureClass}`);
  return layer;
}

export function isQuotaStop(failureClass: FailureClass | null): boolean {
  return failureClass !== null && QUOTA_STOP_FAILURES.has(failureClass);
}

export function isInfraStop(failureClass: FailureClass | null): boolean {
  return failureClass !== null && INFRA_STOP_FAILURES.has(failureClass);
}
