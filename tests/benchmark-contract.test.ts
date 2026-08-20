import { describe, expect, it } from 'vitest';
import type { SanitizedBridgeTraceRecord } from '../src/benchmark/bridge-trace.js';
import {
  CANONICAL_CASE_IDS,
  createCanonicalCases,
  requestHashForCase,
  sentinelFor,
} from '../src/benchmark/cases.js';
import {
  BenchmarkCaseSchema,
  BenchmarkEvidenceSchema,
  type BenchmarkEvidence,
} from '../src/benchmark/schema.js';
import { validateRetainedTraceJoins } from '../src/benchmark/trace-join.js';
import {
  METRIC_NAMES,
  type BenchmarkCase,
  type CanonicalCaseId,
  type TrialMetrics,
} from '../src/benchmark/types.js';
import { requireValue } from './support/strict-accessors.js';

function metricsFor(testCase: BenchmarkCase): TrialMetrics {
  return Object.fromEntries(
    METRIC_NAMES.map((name, index) => [name, testCase.nullMetrics.includes(name) ? null : index]),
  ) as TrialMetrics;
}

function validEvidence(case_id: CanonicalCaseId = 'tool_auto_single'): BenchmarkEvidence {
  const testCase = createCanonicalCases().find((candidate) => candidate.id === case_id);
  if (!testCase) throw new Error(`missing canonical case ${case_id}`);
  const lane = 'yorha' as const;
  return {
    schema_version: 'cursor-composer-parity-metrics/v1',
    suite: {
      seed: 20260818,
      profile: 'smoke',
      generated_at: '2026-08-18T00:00:00.000Z',
    },
    environment: { nodeVersion: 'v22.0.0', backend: 'cursor-api' },
    cases: [testCase],
    trials: [
      {
        case_id,
        pair_index: 0,
        lane,
        sentinel: sentinelFor(case_id, 20260818, 0, lane),
        prompt_hash: requestHashForCase(testCase),
        injection_manifest: testCase.injectionManifest,
        stream_mode: testCase.streamModes[lane],
        events: [
          { type: 'accepted', atMs: 0 },
          {
            type: 'complete_call',
            atMs: 1,
            callIndex: 0,
            callIdHash: 'a'.repeat(64),
            name: 'echo_value',
            argumentsHash: 'b'.repeat(64),
          },
          {
            type: 'execution_end',
            atMs: 2,
            callIdHash: 'a'.repeat(64),
            name: 'echo_value',
            isError: false,
          },
          { type: 'terminal', atMs: 10, reason: 'completed' },
        ],
        trace_join: {
          sequence_start: 1,
          sequence_end: 2,
          request_ids: ['req-contract'],
          record_count: 2,
          attributed_run_count: 1,
          synchronized: true,
        },
        child_report: {
          diagnostics: '',
          exits: [{ code: 0, signal: null }],
          session: {
            entry_kinds: { session: 1, message: 1 },
            assistant_stop_reasons: { stop: 1 },
            errored_assistant_messages: 0,
            user_messages: 1,
          },
        },
        canonical_tool_calls: [{ call_index: 0, name: 'echo_value', executed: true }],
        metrics: metricsFor(testCase),
        passed: true,
        failure_class: null,
        owning_layer: null,
        upstream_runs: 1,
      },
    ],
    statistics: [],
    overhead: [],
    first_divergences: [],
    companions: {
      files: [
        { kind: 'bridge_trace', path: 'test.bridge-trace.jsonl' },
        {
          kind: 'versions_environment',
          path: 'test.versions-environment.json',
        },
        { kind: 'command_exit', path: 'test.command-exit.json' },
        { kind: 'cleanup', path: 'test.cleanup.json' },
      ],
      account_mismatch: true,
      latency_confounded: true,
      account_comparability: {
        status: 'unproved',
        method: 'none',
        reason: 'bridge_credential_missing',
        identity_status: 'unproved',
        cryptographic_identity_proven: false,
        native_claim_available: false,
        bridge_claim_available: false,
        bridge_exchange_available: false,
        account_mismatch: true,
        latency_confounded: true,
      },
    },
    gates: [],
    verdict: 'pass',
  };
}

function validEmptyMalformedEvidence(): BenchmarkEvidence {
  const evidence = validEvidence('malformed_json');
  const trial = evidence.trials[0];
  trial.trace_join = {
    sequence_start: null,
    sequence_end: null,
    request_ids: [],
    record_count: 0,
    attributed_run_count: 0,
    synchronized: true,
  };
  trial.canonical_tool_calls = [];
  trial.upstream_runs = 0;
  return evidence;
}

function expectTraceJoinRejected(
  evidence: BenchmarkEvidence,
  records: readonly SanitizedBridgeTraceRecord[] = [],
): void {
  const parsed = BenchmarkEvidenceSchema.safeParse(evidence);
  expect(parsed.success).toBe(false);
  if (!parsed.success) {
    expect(parsed.error.issues.map(({ path }) => path)).toContainEqual(['trials', 0, 'trace_join']);
  }
  expect(() => validateRetainedTraceJoins(evidence, records)).toThrow();
}

describe('benchmark contract', () => {
  it('round-trips every canonical case without lossy fields', () => {
    const cases = createCanonicalCases();
    expect(cases.map(({ id }) => id)).toEqual(CANONICAL_CASE_IDS);
    for (const testCase of cases) {
      const serialized = JSON.parse(JSON.stringify(testCase)) as unknown;
      expect(BenchmarkCaseSchema.parse(serialized)).toEqual(testCase);
    }
  });

  it('returns a fresh canonical case graph on every call', () => {
    const first = createCanonicalCases();
    const second = createCanonicalCases();
    expect(first).not.toBe(second);
    expect(first[0]).not.toBe(second[0]);
    first[0].request.tools.push('mutated_tool');
    expect(createCanonicalCases()[0].request.tools).not.toContain('mutated_tool');
  });

  it('derives stable lane-specific sentinels and hashes the injection manifest', () => {
    const testCase = createCanonicalCases()[0];
    expect(sentinelFor(testCase.id, 20260818, 3, 'native')).toMatch(
      /^BENCH_TEXT_SENTINEL_STREAM_NATIVE_[A-F0-9]{12}$/,
    );
    expect(sentinelFor(testCase.id, 20260818, 3, 'native')).toBe(
      sentinelFor(testCase.id, 20260818, 3, 'native'),
    );
    expect(sentinelFor(testCase.id, 20260818, 3, 'native')).not.toBe(
      sentinelFor(testCase.id, 20260818, 3, 'yorha'),
    );
    expect(requestHashForCase(testCase)).not.toBe(
      requestHashForCase({
        ...testCase,
        injectionManifest: [
          {
            kind: 'wire_tool_name',
            lane: 'yorha',
            logicalName: 'echo_value',
            injectedName: 'echo_value__wire',
          },
        ],
      }),
    );
  });

  it('rejects duplicate case ids', () => {
    const evidence = validEvidence();
    evidence.cases.push(structuredClone(evidence.cases[0]));
    const result = BenchmarkEvidenceSchema.safeParse(evidence);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map(({ path }) => path)).toContainEqual(['cases', 1, 'id']);
    }
  });

  it('rejects unknown failure classes at a stable path', () => {
    const evidence = validEvidence() as unknown as Record<string, unknown>;
    const trials = evidence.trials as Array<Record<string, unknown>>;
    trials[0].failure_class = 'made_up_failure';
    const result = BenchmarkEvidenceSchema.safeParse(evidence);
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues[0]?.path).toEqual(['trials', 0, 'failure_class']);
  });

  it('rejects non-null inapplicable metrics and missing nullable metrics', () => {
    const nonNull = validEvidence();
    nonNull.trials[0].metrics.first_semantic_ms = 0;
    const nonNullResult = BenchmarkEvidenceSchema.safeParse(nonNull);
    expect(nonNullResult.success).toBe(false);
    if (!nonNullResult.success) {
      expect(nonNullResult.error.issues.map(({ path }) => path)).toContainEqual([
        'trials',
        0,
        'metrics',
        'first_semantic_ms',
      ]);
    }

    const missing = validEvidence() as unknown as Record<string, unknown>;
    const trials = missing.trials as Array<Record<string, unknown>>;
    const metrics = trials[0].metrics as Record<string, unknown>;
    delete metrics.first_semantic_ms;
    const missingResult = BenchmarkEvidenceSchema.safeParse(missing);
    expect(missingResult.success).toBe(false);
    if (!missingResult.success) {
      expect(missingResult.error.issues.map(({ path }) => path)).toContainEqual([
        'trials',
        0,
        'metrics',
        'first_semantic_ms',
      ]);
    }
  });

  it('rejects request hashes without injection manifests', () => {
    const evidence = validEvidence() as unknown as Record<string, unknown>;
    const trials = evidence.trials as Array<Record<string, unknown>>;
    delete trials[0].injection_manifest;
    const result = BenchmarkEvidenceSchema.safeParse(evidence);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map(({ path }) => path)).toContainEqual([
        'trials',
        0,
        'injection_manifest',
      ]);
    }
  });

  it.each(['token', 'clientSecret', 'authorizationHeader'])(
    'rejects secret-like evidence key %s',
    (key) => {
      const evidence = validEvidence() as unknown as Record<string, unknown>;
      const environment = evidence.environment as Record<string, unknown>;
      environment[key] = 'redacted-looking-but-forbidden';
      const result = BenchmarkEvidenceSchema.safeParse(evidence);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.map(({ path }) => path)).toContainEqual(['environment', key]);
      }
    },
  );

  it.each([
    ['passing', (evidence: BenchmarkEvidence) => evidence],
    [
      'retained failed',
      (evidence: BenchmarkEvidence) => {
        evidence.trials[0].passed = false;
        evidence.trials[0].failure_class = 'transport';
        evidence.trials[0].owning_layer = 'transport';
        return evidence;
      },
    ],
  ])('rejects a %s trial with zero lifecycle events', (_, prepare) => {
    const evidence = prepare(validEvidence());
    evidence.trials[0].events = [];
    const result = BenchmarkEvidenceSchema.safeParse(evidence);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map(({ path }) => path)).toContainEqual(['trials', 0, 'events']);
    }
  });

  it('rejects successful yorha evidence without a retained trial-to-trace join', () => {
    const evidence = validEvidence('text_sentinel_stream');
    evidence.trials[0].trace_join = null;
    const result = BenchmarkEvidenceSchema.safeParse(evidence);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map(({ path }) => path)).toContainEqual([
        'trials',
        0,
        'trace_join',
      ]);
    }
  });

  it.each([
    [
      'attributed Run mismatch',
      (evidence: BenchmarkEvidence) => {
        requireValue(evidence.trials[0].trace_join, 'trial trace_join').attributed_run_count = 0;
      },
    ],
    [
      'successful bridge trial with zero attributable Runs',
      (evidence: BenchmarkEvidence) => {
        evidence.trials[0].upstream_runs = 0;
        evidence.trials[0].trace_join = {
          sequence_start: null,
          sequence_end: null,
          request_ids: [],
          record_count: 0,
          attributed_run_count: 0,
          synchronized: true,
        };
      },
    ],
    [
      'ambiguous overlapping sequence range',
      (evidence: BenchmarkEvidence) => {
        const duplicate = structuredClone(evidence.trials[0]);
        duplicate.pair_index = 1;
        duplicate.sentinel = sentinelFor(duplicate.case_id, 20260818, 1, duplicate.lane);
        requireValue(duplicate.trace_join, 'duplicate trace_join').request_ids = [
          'req-contract-other',
        ];
        evidence.trials.push(duplicate);
      },
    ],
  ])('rejects %s in a persisted trace join', (_name, mutate) => {
    const evidence = validEvidence('text_sentinel_stream');
    mutate(evidence);
    const result = BenchmarkEvidenceSchema.safeParse(evidence);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map(({ path }) => path)).toContainEqual([
        'trials',
        expect.any(Number),
        'trace_join',
      ]);
    }
  });

  it('preserves a valid malformed yorha trial with an empty zero-Run join', () => {
    const evidence = validEmptyMalformedEvidence();
    expect(BenchmarkEvidenceSchema.safeParse(evidence).success).toBe(true);
    expect(() => validateRetainedTraceJoins(evidence, [])).not.toThrow();
  });

  it('rejects the verifier mutation claiming a failed Run with an empty retained join', () => {
    const evidence = validEmptyMalformedEvidence();
    const trial = evidence.trials[0];
    trial.passed = false;
    trial.failure_class = 'infra_fail';
    trial.owning_layer = 'infrastructure';
    trial.upstream_runs = 1;
    requireValue(trial.trace_join, 'trial trace_join').attributed_run_count = 1;
    evidence.gates = [
      {
        id: 'correctness.malformed_json',
        case_id: 'malformed_json',
        metric: null,
        status: 'fail',
        observed: 0,
        threshold: 1,
      },
    ];
    evidence.first_divergences = [
      {
        gate_id: 'correctness.malformed_json',
        case_id: 'malformed_json',
        metric: null,
        failure_class: 'infra_fail',
        owning_layer: 'infrastructure',
      },
    ];
    evidence.verdict = 'infra_fail';

    expectTraceJoinRejected(evidence);
  });

  it.each([
    ['attributed Run only', 1, 0],
    ['trial upstream Run only', 0, 1],
  ])('rejects an empty join with a mismatched %s claim', (_name, attributed, upstream) => {
    const evidence = validEmptyMalformedEvidence();
    requireValue(evidence.trials[0].trace_join, 'trial trace_join').attributed_run_count =
      attributed;
    evidence.trials[0].upstream_runs = upstream;
    expectTraceJoinRejected(evidence);
  });

  it.each([
    ['start only', 1, null],
    ['end only', null, 1],
  ])('rejects partial-null trace bounds with %s', (_name, start, end) => {
    const evidence = validEmptyMalformedEvidence();
    evidence.trials[0].trace_join = {
      sequence_start: start,
      sequence_end: end,
      request_ids: ['req-partial'],
      record_count: 1,
      attributed_run_count: 0,
      synchronized: true,
    };
    expectTraceJoinRejected(evidence);
  });

  it('rejects nonzero retained records with empty request IDs', () => {
    const evidence = validEmptyMalformedEvidence();
    evidence.trials[0].trace_join = {
      sequence_start: 1,
      sequence_end: 1,
      request_ids: [],
      record_count: 1,
      attributed_run_count: 0,
      synchronized: true,
    };
    expectTraceJoinRejected(evidence, [
      {
        sequence: 1,
        request_id: 'req-missing-from-join',
        credential_slot_id: null,
        backend: 'cursor-api',
        model: 'composer-2.5',
        upstream_run_count: 0,
        stage: 'accepted',
        offset_ms: 0,
      },
    ]);
  });

  it.each([
    [
      'missing child report',
      (evidence: BenchmarkEvidence) =>
        delete (evidence.trials[0] as unknown as Record<string, unknown>).child_report,
    ],
    [
      'oversized diagnostics',
      (evidence: BenchmarkEvidence) => {
        evidence.trials[0].child_report.diagnostics = 'x'.repeat(4097);
      },
    ],
    [
      'negative session counts',
      (evidence: BenchmarkEvidence) => {
        requireValue(
          evidence.trials[0].child_report.session,
          'child report session',
        ).user_messages = -1;
      },
    ],
  ])('rejects a persisted child report with %s', (_name, mutate) => {
    const evidence = validEvidence('text_sentinel_stream');
    evidence.trials[0].trace_join = {
      sequence_start: 1,
      sequence_end: 1,
      request_ids: ['req-child-report'],
      record_count: 1,
      attributed_run_count: 1,
      synchronized: true,
    };
    mutate(evidence);
    const result = BenchmarkEvidenceSchema.safeParse(evidence);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some(
          ({ path }) => path[0] === 'trials' && path[1] === 0 && path[2] === 'child_report',
        ),
      ).toBe(true);
    }
  });

  it('rejects a required tool pass with zero canonical execution receipts', () => {
    const evidence = validEvidence();
    evidence.trials[0].canonical_tool_calls = [];
    const result = BenchmarkEvidenceSchema.safeParse(evidence);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map(({ path }) => path)).toContainEqual([
        'trials',
        0,
        'canonical_tool_calls',
      ]);
    }
  });

  it('rejects malformed trial shapes independently', () => {
    const probes: Array<[string, (value: Record<string, unknown>) => void]> = [
      [
        'negative pair index',
        (value) => ((value.trials as Array<Record<string, unknown>>)[0].pair_index = -1),
      ],
      [
        'unknown lane',
        (value) => ((value.trials as Array<Record<string, unknown>>)[0].lane = 'remote'),
      ],
      [
        'unknown event',
        (value) =>
          ((value.trials as Array<Record<string, unknown>>)[0].events = [
            { type: 'mystery', atMs: 0 },
          ]),
      ],
      [
        'negative timing',
        (value) =>
          ((
            (value.trials as Array<Record<string, unknown>>)[0].metrics as Record<string, unknown>
          ).accepted_ms = -1),
      ],
    ];
    for (const [, mutate] of probes) {
      const evidence = validEvidence() as unknown as Record<string, unknown>;
      mutate(evidence);
      expect(BenchmarkEvidenceSchema.safeParse(evidence).success).toBe(false);
    }
  });
});
