import type { SanitizedBridgeTraceRecord } from './bridge-trace.js';
import { attributeRequestIds } from './bridge-trace.js';
import type { BenchmarkEvidence } from './types.js';

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function validateRetainedTraceJoins(
  evidence: BenchmarkEvidence,
  records: readonly SanitizedBridgeTraceRecord[],
): void {
  const claimedSequences = new Set<number>();
  for (const trial of evidence.trials) {
    if (trial.lane !== 'yorha') continue;
    const join = trial.trace_join;
    if (!join) throw new Error('yorha trial is missing retained trace join');
    if (join.sequence_start === null || join.sequence_end === null) {
      if (
        join.sequence_start !== null ||
        join.sequence_end !== null ||
        join.record_count !== 0 ||
        join.request_ids.length !== 0 ||
        join.attributed_run_count !== 0 ||
        trial.upstream_runs !== 0
      ) {
        throw new Error('empty trace join must claim zero retained records and Runs');
      }
      continue;
    }
    if (join.record_count === 0 || join.request_ids.length === 0) {
      throw new Error('nonempty trace join requires retained records and request IDs');
    }
    const start = join.sequence_start;
    const end = join.sequence_end;
    const scoped = records.filter((record) => record.sequence >= start && record.sequence <= end);
    const requestIds = attributeRequestIds(scoped);
    const runCount = scoped.filter((record) => record.stage === 'run_open').length;
    if (
      scoped.length !== join.record_count ||
      !sameValues(requestIds, join.request_ids) ||
      runCount !== join.attributed_run_count ||
      runCount !== trial.upstream_runs
    ) {
      throw new Error('retained trace records do not match trial attribution');
    }
    for (const record of scoped) {
      if (claimedSequences.has(record.sequence)) {
        throw new Error('retained trace sequence is ambiguously attributed');
      }
      claimedSequences.add(record.sequence);
    }
  }
  // Only attribution-opening records must belong to a trial span. Sticky-Run
  // resumes and held-run timeouts can flush records tagged with an older
  // request id after that trial's span closed; those are replays, not new
  // attribution.
  const unattributed = records.some(
    (record) =>
      !claimedSequences.has(record.sequence) &&
      (record.stage === 'accepted' || record.stage === 'run_open'),
  );
  if (unattributed) {
    throw new Error('retained trace record is not joined to a yorha trial');
  }
}
