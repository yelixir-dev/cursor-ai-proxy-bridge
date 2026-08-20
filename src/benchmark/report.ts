import { accountComparabilityRows } from './account-report.js';
import { countCorrectness, medianUpstreamRuns, type ResidualOverhead } from './statistics.js';
import { pairedToolChoiceMeasurement } from './measurement-surface.js';
import type { PairScheduleEntry } from './schedule.js';
import type { BenchmarkEvidence, MetricStatistic, PairedStatistic, TrialRecord } from './types.js';

export interface MarkdownReportInput {
  evidence: BenchmarkEvidence;
  schedule: readonly PairScheduleEntry[];
  residuals?: readonly ResidualOverhead[];
  isMeasured: (trial: TrialRecord) => boolean;
}

function row(cells: readonly (string | number | null)[]): string {
  return `| ${cells.map((cell) => (cell === null ? '-' : String(cell))).join(' | ')} |`;
}

function ms(value: number | null | undefined): string {
  return value === null || value === undefined ? '-' : value.toFixed(2);
}

function scheduleTable(input: MarkdownReportInput): string[] {
  const lines = ['| case | warmup pairs | measured pairs | lanes |', '| --- | --- | --- | --- |'];
  const byCase = new Map<string, { warmup: number; measured: number; lanes: Set<string> }>();
  for (const entry of input.schedule) {
    const group = byCase.get(entry.caseId) ?? {
      warmup: 0,
      measured: 0,
      lanes: new Set<string>(),
    };
    if (entry.phase === 'warmup') group.warmup += 1;
    else group.measured += 1;
    for (const lane of entry.lanes) group.lanes.add(lane);
    byCase.set(entry.caseId, group);
  }
  for (const [caseId, group] of [...byCase.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    lines.push(row([caseId, group.warmup, group.measured, [...group.lanes].sort().join(', ')]));
  }
  return lines;
}

function fullScheduleTable(input: MarkdownReportInput): string[] {
  const lines = ['| # | case | pair | phase | lane order |', '| --- | --- | --- | --- | --- |'];
  input.schedule.forEach((entry, index) => {
    lines.push(
      row([index + 1, entry.caseId, entry.pairIndex, entry.phase, entry.lanes.join(' -> ')]),
    );
  });
  return lines;
}

function correctnessTable(input: MarkdownReportInput): string[] {
  const counts = countCorrectness({
    trials: input.evidence.trials,
    isMeasured: input.isMeasured,
  });
  if (counts.length === 0) return [];
  const lines = [
    '| case | measured pass | measured fail | warmup excluded |',
    '| --- | --- | --- | --- |',
  ];
  for (const entry of counts) {
    lines.push(row([entry.case_id, entry.passed, entry.failed, entry.warmup_excluded]));
  }
  return lines;
}

function toolChoiceSurfaceTable(input: MarkdownReportInput): string[] {
  const rows = input.evidence.cases
    .map((testCase) => pairedToolChoiceMeasurement(testCase))
    .filter((measurement): measurement is NonNullable<typeof measurement> => measurement !== null);
  if (rows.length === 0) return [];
  const lines = [
    '| case | requested tool choice | transmits openai tool_choice | paired surface |',
    '| --- | --- | --- | --- |',
  ];
  for (const measurement of rows) {
    lines.push(
      row([
        measurement.case_id,
        measurement.requested_tool_choice,
        String(measurement.transmits_openai_tool_choice),
        measurement.surface,
      ]),
    );
  }
  return lines;
}

function laneStatisticsTable(input: MarkdownReportInput): string[] {
  const stats = input.evidence.statistics.filter(
    (entry): entry is MetricStatistic => 'sample_count' in entry,
  );
  if (stats.length === 0) return [];
  const lines = [
    '| case | metric | lane | n | median | p10 | p90 | iqr |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const entry of stats) {
    lines.push(
      row([
        entry.case_id,
        entry.metric,
        entry.lane,
        entry.sample_count,
        ms(entry.median),
        ms(entry.p10),
        ms(entry.p90),
        ms(entry.iqr),
      ]),
    );
  }
  return lines;
}

function pairedTable(input: MarkdownReportInput): string[] {
  const stats = input.evidence.statistics.filter(
    (entry): entry is PairedStatistic => 'valid_pairs' in entry,
  );
  if (stats.length === 0) return [];
  const lines = [
    '| case | metric | pairs | median ratio | ci95 lower | ci95 upper |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const entry of stats) {
    lines.push(
      row([
        entry.case_id,
        entry.metric,
        entry.valid_pairs,
        entry.median_ratio.toFixed(4),
        entry.ci95.lower.toFixed(4),
        entry.ci95.upper.toFixed(4),
      ]),
    );
  }
  return lines;
}

function overheadTable(input: MarkdownReportInput): string[] {
  const lines = [
    '| case | turns | Raw total gap ms | Expected OpenAI surface cost ms | Residual bridge overhead ms |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const entry of input.evidence.overhead) {
    lines.push(
      row([
        entry.case_id,
        entry.turns,
        ms(entry.raw_total_gap_ms),
        ms(entry.expected_openai_surface_cost_ms),
        ms(entry.residual_bridge_overhead_ms),
      ]),
    );
  }
  return lines;
}

function companionTable(input: MarkdownReportInput): string[] {
  const lines = ['| kind | path |', '| --- | --- |'];
  for (const file of input.evidence.companions.files) lines.push(row([file.kind, file.path]));
  const comparison = input.evidence.companions.account_comparability;
  lines.push(...accountComparabilityRows(comparison).map((entry) => row(entry)));
  lines.push(row(['account_mismatch', String(input.evidence.companions.account_mismatch)]));
  lines.push(row(['latency_confounded', String(input.evidence.companions.latency_confounded)]));
  return lines;
}

function divergenceTable(input: MarkdownReportInput): string[] {
  const lines = [
    '| gate | case | metric | failure class | first owner |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const entry of input.evidence.first_divergences) {
    lines.push(
      row([entry.gate_id, entry.case_id, entry.metric, entry.failure_class, entry.owning_layer]),
    );
  }
  return lines;
}

function upstreamTable(input: MarkdownReportInput): string[] {
  const runs = medianUpstreamRuns({
    trials: input.evidence.trials,
    isMeasured: input.isMeasured,
  });
  if (runs.length === 0) return [];
  const lines = ['| case | lane | median upstream runs |', '| --- | --- | --- |'];
  for (const entry of runs) {
    lines.push(row([entry.case_id, entry.lane, entry.median_upstream_runs]));
  }
  return lines;
}

function gateTable(input: MarkdownReportInput): string[] {
  if (input.evidence.gates.length === 0) return [];
  const lines = ['| gate | status | observed | threshold |', '| --- | --- | --- | --- |'];
  for (const gate of input.evidence.gates) {
    lines.push(
      row([
        gate.id,
        gate.status,
        gate.observed === null ? null : Number(gate.observed.toFixed(4)),
        gate.threshold,
      ]),
    );
  }
  return lines;
}

function failureTable(input: MarkdownReportInput): string[] {
  const failures = input.evidence.trials.filter((trial) => !trial.passed);
  if (failures.length === 0) return [];
  const lines = ['| case | pair | lane | failure class |', '| --- | --- | --- | --- |'];
  for (const trial of failures) {
    lines.push(row([trial.case_id, trial.pair_index, trial.lane, trial.failure_class]));
  }
  return lines;
}

function section(title: string, lines: readonly string[]): string[] {
  return lines.length === 0 ? [] : [`## ${title}`, '', ...lines, ''];
}

export function renderMarkdownReport(input: MarkdownReportInput): string {
  const { evidence } = input;
  const dryRun = evidence.environment.dry_run === 'true';
  const lines: string[] = [
    '# Cursor Composer parity benchmark',
    '',
    row(['profile', evidence.suite.profile]),
    row(['seed', evidence.suite.seed]),
    row(['verdict', evidence.verdict]),
    row(['generated_at', evidence.suite.generated_at]),
    row(['schema', evidence.schema_version]),
    row(['trials', evidence.trials.length]),
    '',
  ];
  if (dryRun) {
    lines.push(
      '> DRY RUN - no trials were executed, no network calls were made, and the verdict is intentionally not a pass.',
      '',
    );
  }
  lines.push(
    ...section('Pair schedule (per case)', scheduleTable(input)),
    ...(dryRun ? section('Exact pair schedule', fullScheduleTable(input)) : []),
    ...section('Correctness', correctnessTable(input)),
    ...section('Paired tool-choice measurement surfaces', toolChoiceSurfaceTable(input)),
    ...section('Latency by lane', laneStatisticsTable(input)),
    ...section('Paired ratios (yorha/native)', pairedTable(input)),
    ...section('Raw total gap and bridge overhead', overheadTable(input)),
    ...section('First divergences', divergenceTable(input)),
    ...section('Companion artifacts', companionTable(input)),
    ...section('Upstream runs', upstreamTable(input)),
    ...section('Gates', gateTable(input)),
    ...section('Failures', failureTable(input)),
  );
  return `${lines.join('\n').trimEnd()}\n`;
}
