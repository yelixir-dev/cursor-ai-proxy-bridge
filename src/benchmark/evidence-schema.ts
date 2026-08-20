import { z } from 'zod';
import { AccountComparabilitySchema, validateAccountComparability } from './account-schema.js';
import { validateLifecycleAttribution } from './lifecycle-schema.js';
import {
  CANONICAL_CASE_IDS,
  FAILURE_CLASSES,
  METRIC_NAMES,
  OWNING_LAYERS,
  type BenchmarkEvidence,
} from './types.js';

export { TrialTraceJoinSchema } from './lifecycle-schema.js';

const nonnegative = z.number().finite().nonnegative();
const CaseIdSchema = z.enum(CANONICAL_CASE_IDS);
const MetricNameSchema = z.enum(METRIC_NAMES);
const FailureClassSchema = z.enum(FAILURE_CLASSES);

const CompanionKindSchema = z.enum([
  'bridge_trace',
  'versions_environment',
  'command_exit',
  'cleanup',
]);

export const EvidenceAdditionsShape = {
  overhead: z.array(
    z.strictObject({
      case_id: CaseIdSchema,
      turns: z.number().int().min(2),
      raw_total_gap_ms: z.number().finite(),
      expected_openai_surface_cost_ms: nonnegative,
      residual_bridge_overhead_ms: z.number().finite(),
    }),
  ),
  first_divergences: z.array(
    z.strictObject({
      gate_id: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[a-z0-9_.-]+$/),
      case_id: CaseIdSchema,
      metric: MetricNameSchema.nullable(),
      failure_class: FailureClassSchema.nullable(),
      owning_layer: z.enum(OWNING_LAYERS),
    }),
  ),
  companions: z.strictObject({
    files: z
      .array(
        z.strictObject({
          kind: CompanionKindSchema,
          path: z.string().regex(/^[A-Za-z0-9_.-]+$/),
        }),
      )
      .length(4),
    account_mismatch: z.boolean(),
    latency_confounded: z.boolean(),
    account_comparability: AccountComparabilitySchema,
  }),
};

export function validateEvidenceAdditions(
  evidence: Pick<
    BenchmarkEvidence,
    'cases' | 'companions' | 'first_divergences' | 'gates' | 'trials'
  >,
  context: z.RefinementCtx,
): void {
  const cases = new Map(evidence.cases.map((testCase) => [testCase.id, testCase]));
  const occupiedSequences = new Set<number>();
  const occupiedRequestIds = new Set<string>();
  evidence.trials.forEach((trial, index) => {
    const join = trial.trace_join;
    if (trial.lane === 'native' && join !== null) {
      context.addIssue({
        code: 'custom',
        path: ['trials', index, 'trace_join'],
        message: 'native trial cannot claim bridge trace',
      });
      return;
    }
    if (trial.lane !== 'yorha') return;
    if (join === null) {
      context.addIssue({
        code: 'custom',
        path: ['trials', index, 'trace_join'],
        message: 'yorha trial requires a retained trace join',
      });
      return;
    }
    const empty = join.record_count === 0;
    const boundsMatch = empty
      ? join.sequence_start === null &&
        join.sequence_end === null &&
        join.request_ids.length === 0 &&
        join.attributed_run_count === 0 &&
        trial.upstream_runs === 0
      : join.sequence_start !== null &&
        join.sequence_end !== null &&
        join.sequence_start <= join.sequence_end &&
        join.request_ids.length > 0 &&
        join.record_count === join.sequence_end - join.sequence_start + 1;
    if (!boundsMatch || join.attributed_run_count !== trial.upstream_runs) {
      context.addIssue({
        code: 'custom',
        path: ['trials', index, 'trace_join'],
        message: 'trace join bounds or attributed Runs mismatch',
      });
    }
    validateLifecycleAttribution(join, index, context);
    const testCase = cases.get(trial.case_id);
    if (
      trial.passed &&
      (!join.synchronized ||
        (testCase?.kind !== 'malformed' &&
          (join.attributed_run_count === 0 || join.request_ids.length === 0)))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['trials', index, 'trace_join'],
        message: 'successful bridge trial requires a synchronized attributable Run join',
      });
    }
    if (join.sequence_start !== null && join.sequence_end !== null) {
      for (let sequence = join.sequence_start; sequence <= join.sequence_end; sequence += 1) {
        if (occupiedSequences.has(sequence)) {
          context.addIssue({
            code: 'custom',
            path: ['trials', index, 'trace_join'],
            message: 'ambiguous overlapping trace sequence range',
          });
          break;
        }
        occupiedSequences.add(sequence);
      }
    }
    for (const requestId of join.request_ids) {
      if (occupiedRequestIds.has(requestId)) {
        context.addIssue({
          code: 'custom',
          path: ['trials', index, 'trace_join'],
          message: 'ambiguous reused trace request id',
        });
      }
      occupiedRequestIds.add(requestId);
    }
  });

  const companionKinds = evidence.companions.files.map((file) => file.kind);
  for (const kind of CompanionKindSchema.options) {
    if (companionKinds.filter((candidate) => candidate === kind).length !== 1) {
      context.addIssue({
        code: 'custom',
        path: ['companions', 'files'],
        message: `requires exactly one ${kind} companion`,
      });
    }
  }
  validateAccountComparability(evidence.companions, context);
  const failedGateIds = evidence.gates
    .filter((gate) => gate.status === 'fail' && gate.case_id !== null)
    .map((gate) => gate.id)
    .sort();
  const divergenceIds = evidence.first_divergences.map((row) => row.gate_id).sort();
  if (JSON.stringify(failedGateIds) !== JSON.stringify(divergenceIds)) {
    context.addIssue({
      code: 'custom',
      path: ['first_divergences'],
      message: 'every failed case or metric gate requires exactly one first-divergence owner',
    });
  }
}

export function validateCanonicalToolEvidence(
  trial: BenchmarkEvidence['trials'][number],
  testCase: BenchmarkEvidence['cases'][number],
  index: number,
  context: z.RefinementCtx,
): void {
  if (!trial.passed || testCase.oracle.kind !== 'tools') return;
  const completed = trial.events.filter((event) => event.type === 'complete_call');
  const executed = trial.events.filter(
    (event) => event.type === 'execution_end' && 'isError' in event && !event.isError,
  );
  const receiptsAreReal = trial.canonical_tool_calls.every((receipt) => {
    const call = completed.find(
      (event) => event.callIndex === receipt.call_index && event.name === receipt.name,
    );
    return (
      call !== undefined &&
      receipt.executed ===
        executed.some(
          (event) =>
            'name' in event && event.name === receipt.name && event.callIdHash === call.callIdHash,
        )
    );
  });
  const expected = new Map<string, number>();
  for (const name of testCase.oracle.names) expected.set(name, (expected.get(name) ?? 0) + 1);
  const actual = new Map<string, number>();
  for (const receipt of trial.canonical_tool_calls) {
    if (receipt.executed) actual.set(receipt.name, (actual.get(receipt.name) ?? 0) + 1);
  }
  const countsMatch = [...expected].every(([name, count]) => actual.get(name) === count);
  if (receiptsAreReal && countsMatch) return;
  context.addIssue({
    code: 'custom',
    path: ['trials', index, 'canonical_tool_calls'],
    message: 'passing tool trial requires real executed canonical call receipts',
  });
}

export function rejectSecretKeys(
  value: unknown,
  context: z.RefinementCtx,
  path: PropertyKey[] = [],
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      rejectSecretKeys(item, context, [...path, index]);
    });
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (/(token|secret|auth)/i.test(key)) {
      context.addIssue({
        code: 'custom',
        path: [...path, key],
        message: 'secret-like evidence key is forbidden',
      });
    }
    rejectSecretKeys(item, context, [...path, key]);
  }
}
