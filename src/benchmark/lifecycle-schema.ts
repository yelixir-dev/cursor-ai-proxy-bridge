import { z } from 'zod';
import type { TrialTraceJoin } from './lifecycle-types.js';

const safeTraceId = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);

export const TrialTraceJoinSchema = z.strictObject({
  sequence_start: z.number().int().positive().nullable(),
  sequence_end: z.number().int().positive().nullable(),
  request_ids: z.array(safeTraceId),
  record_count: z.number().int().nonnegative(),
  attributed_run_count: z.number().int().nonnegative(),
  retry_count: z.number().int().nonnegative().optional(),
  retry_reasons: z.array(z.enum(['server', 'transport', 'tool_validation'])).optional(),
  active_backend: safeTraceId.nullable().optional(),
  usage_source: z.enum(['turnEnded', 'cli_reported', 'estimated', 'unknown']).optional(),
  final_backend_state: safeTraceId.nullable().optional(),
  cancelled: z.boolean().optional(),
  quiescent: z.boolean().optional(),
  synchronized: z.boolean(),
});

export function validateLifecycleAttribution(
  join: TrialTraceJoin,
  trialIndex: number,
  context: z.RefinementCtx,
): void {
  const fields = [
    join.retry_count,
    join.retry_reasons,
    join.active_backend,
    join.usage_source,
    join.final_backend_state,
    join.cancelled,
    join.quiescent,
  ];
  const attributed = fields.some((value) => value !== undefined);
  if (
    attributed &&
    (fields.some((value) => value === undefined) || join.retry_count !== join.retry_reasons?.length)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['trials', trialIndex, 'trace_join'],
      message: 'lifecycle attribution fields must be complete and retry counts must match',
    });
  }
  if (join.active_backend === 'cursor-api' && join.usage_source === 'estimated') {
    context.addIssue({
      code: 'custom',
      path: ['trials', trialIndex, 'trace_join', 'usage_source'],
      message: 'cursor-api usage cannot be estimated',
    });
  }
}
