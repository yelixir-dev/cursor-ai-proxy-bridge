import { describe, expect, it } from 'vitest';
import { createCanonicalCases, sentinelFor } from '../src/benchmark/cases.js';
import { evaluateGates, verdictFromGates } from '../src/benchmark/statistics.js';
import { omoTrialArgs } from '../src/benchmark/fixture.js';
import {
  isInvalidPairedToolChoiceMeasurement,
  pairedCorrectnessGateId,
  pairedToolChoiceMeasurement,
} from '../src/benchmark/measurement-surface.js';
import { renderMarkdownReport } from '../src/benchmark/report.js';
import { runBenchmark } from '../src/benchmark/runner.js';
import {
  buildPairSchedule,
  buildTrialPrompt,
  expectedCallsFor,
  isMeasuredTrialFactory,
} from '../src/benchmark/schedule.js';
import { sha256Hex } from '../src/benchmark/normalize.js';
import { assembleTrialRecord, type LaneTrialSample } from '../src/benchmark/trial-record.js';
import type { LaneTrialRequest } from '../src/benchmark/trial-record.js';
import type { BenchmarkCase, CanonicalCaseId, TrialRecord } from '../src/benchmark/types.js';
import type { PairedStatistic } from '../src/benchmark/types.js';

const SEED = 20260818;
const CASES = createCanonicalCases();

function caseById(id: CanonicalCaseId): BenchmarkCase {
  const found = CASES.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`missing canonical case ${id}`);
  return found;
}

const emptyChild = () => ({ diagnostics: '', exits: [], session: null });

function spontaneousToolSample(sentinel: string, prompt: string, seq: number): LaneTrialSample {
  return {
    rawEvents: [
      { type: 'agent_start', atMs: 0 },
      {
        type: 'toolcall_end',
        atMs: 1,
        toolCall: {
          id: 'call_spontaneous',
          function: { name: 'echo_value', arguments: JSON.stringify({ value: 'x' }) },
        },
      },
      {
        type: 'tool_execution_start',
        atMs: 2,
        toolCallId: 'call_spontaneous',
        toolName: 'echo_value',
      },
      {
        type: 'tool_execution_end',
        atMs: 3,
        toolCallId: 'call_spontaneous',
        toolName: 'echo_value',
      },
      { type: 'text_delta', atMs: 4, delta: sentinel },
      { type: 'agent_end', atMs: 5 },
    ],
    durationMs: 6,
    upstreamRuns: 2,
    failureClass: null,
    promptHash: sha256Hex(prompt),
    httpStatus: null,
    isolatedSentinels: null,
    traceJoin: {
      sequence_start: seq,
      sequence_end: seq + 1,
      request_ids: [`req-${seq}`],
      record_count: 2,
      attributed_run_count: 2,
      synchronized: true,
    },
    childReport: emptyChild(),
  };
}

function textSample(sentinel: string, prompt: string, seq: number): LaneTrialSample {
  return {
    rawEvents: [
      { type: 'agent_start', atMs: 0 },
      { type: 'text_delta', atMs: 1, delta: sentinel },
      { type: 'agent_end', atMs: 2 },
    ],
    durationMs: 3,
    upstreamRuns: 1,
    failureClass: null,
    promptHash: sha256Hex(prompt),
    httpStatus: null,
    isolatedSentinels: null,
    traceJoin: {
      sequence_start: seq,
      sequence_end: seq,
      request_ids: [`req-${seq}`],
      record_count: 1,
      attributed_run_count: 1,
      synchronized: true,
    },
    childReport: emptyChild(),
  };
}

function laneRequest(
  testCase: BenchmarkCase,
  lane: 'native' | 'yorha',
  sentinel: string,
): LaneTrialRequest {
  const prompt = buildTrialPrompt(testCase, sentinel);
  return {
    testCase,
    pairIndex: 1,
    phase: 'measured',
    lane,
    sentinel,
    peerSentinels: [],
    prompt,
    promptHash: sha256Hex(prompt),
    expectedCalls: expectedCallsFor(testCase, sentinel),
    omoSeed: `${SEED}-test`,
    concurrency: 1,
    signal: new AbortController().signal,
  };
}

function trialRecord(
  caseId: CanonicalCaseId,
  lane: 'native' | 'yorha',
  overrides: Partial<Pick<TrialRecord, 'passed' | 'failure_class' | 'owning_layer'>> & {
    pairIndex?: number;
  } = {},
): TrialRecord {
  const testCase = caseById(caseId);
  const sentinel = sentinelFor(caseId, SEED, overrides.pairIndex ?? 1, lane);
  const request = laneRequest(testCase, lane, sentinel);
  const sample = spontaneousToolSample(sentinel, request.prompt, 1);
  const record = assembleTrialRecord(request, sample);
  const passed = overrides.passed ?? false;
  return {
    ...record,
    pair_index: overrides.pairIndex ?? record.pair_index,
    passed,
    failure_class: overrides.failure_class ?? null,
    owning_layer: overrides.owning_layer ?? null,
  };
}

const noPaired: PairedStatistic[] = [];
const allMeasured = () => true;

describe('paired OMO toolChoice_none measurement surface', () => {
  it('never forwards a tool-choice option to the OMO comparator', () => {
    const argv = omoTrialArgs(
      'yorha',
      'composer-2.5',
      {
        sessionDir: '/sessions',
        toolExtensionPath: '/benchmark-tools.mjs',
      },
      'seed-1',
    );
    expect(argv[argv.indexOf('--tools') + 1]).toBe('echo_value,lookup_code');
    expect(argv.some((token) => /tool[-_]?choice/i.test(token))).toBe(false);
  });

  it('uses the ordinary sentinel prompt with no expected calls on both lanes', () => {
    const noneCase = caseById('toolChoice_none');
    const plainTextCase = caseById('text_sentinel_stream');
    const sentinel = sentinelFor('toolChoice_none', SEED, 1, 'yorha');
    expect(buildTrialPrompt(noneCase, sentinel)).toBe(buildTrialPrompt(plainTextCase, sentinel));
    expect(expectedCallsFor(noneCase, sentinel)).toEqual([]);
  });

  it('schedules the paired case on both native and yorha lanes', () => {
    const schedule = buildPairSchedule({
      seed: SEED,
      profile: 'ci',
      cases: [caseById('toolChoice_none'), caseById('text_sentinel_stream')],
    });
    const entries = schedule.filter((entry) => entry.caseId === 'toolChoice_none');
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect([...entry.lanes].sort()).toEqual(['native', 'yorha']);
    }
  });
});

describe('typed paired tool-choice measurement metadata', () => {
  it('marks every non-auto canonical case as prompt-only, never transmitting the OpenAI field', () => {
    for (const testCase of CASES) {
      const measurement = pairedToolChoiceMeasurement(testCase);
      if (testCase.request.toolChoice === 'auto') {
        expect(measurement).toBeNull();
      } else {
        expect(measurement).toEqual({
          case_id: testCase.id,
          requested_tool_choice: testCase.request.toolChoice,
          transmits_openai_tool_choice: false,
          surface: 'prompt_only',
        });
      }
    }
  });

  it('recognizes only an unsent-field spontaneous tool as an invalid paired measurement', () => {
    const noneCase = caseById('toolChoice_none');
    expect(isInvalidPairedToolChoiceMeasurement(noneCase, 'unexpected_tool')).toBe(true);
    expect(isInvalidPairedToolChoiceMeasurement(noneCase, null)).toBe(false);
    expect(isInvalidPairedToolChoiceMeasurement(noneCase, 'substituted_builtin')).toBe(false);
    expect(isInvalidPairedToolChoiceMeasurement(noneCase, 'sentinel_mismatch')).toBe(false);
    expect(
      isInvalidPairedToolChoiceMeasurement(caseById('toolChoice_required'), 'unexpected_tool'),
    ).toBe(false);
    expect(
      isInvalidPairedToolChoiceMeasurement(caseById('text_sentinel_stream'), 'unexpected_tool'),
    ).toBe(false);
  });
});

describe('spontaneous tool classification for the unsent-field paired case', () => {
  it('keeps the raw trial failed but owns it as model variance', () => {
    const noneCase = caseById('toolChoice_none');
    const sentinel = sentinelFor('toolChoice_none', SEED, 4, 'yorha');
    const request = laneRequest(noneCase, 'yorha', sentinel);
    const trial = assembleTrialRecord(request, spontaneousToolSample(sentinel, request.prompt, 1));
    expect(trial.passed).toBe(false);
    expect(trial.failure_class).toBe('unexpected_tool');
    expect(trial.owning_layer).toBe('model_variance');
  });

  it('still owns bridge failure classes on the same case as tool scheduling', () => {
    const noneCase = caseById('toolChoice_none');
    const sentinel = sentinelFor('toolChoice_none', SEED, 1, 'yorha');
    const request = laneRequest(noneCase, 'yorha', sentinel);
    const trial = assembleTrialRecord(request, {
      ...spontaneousToolSample(sentinel, request.prompt, 1),
      rawEvents: [
        { type: 'agent_start', atMs: 0 },
        {
          type: 'toolcall_end',
          atMs: 1,
          toolCall: {
            id: 'call_builtin',
            function: { name: 'Shell', arguments: JSON.stringify({ command: 'ls' }) },
          },
        },
        { type: 'agent_end', atMs: 2 },
      ],
    });
    expect(trial.failure_class).toBe('substituted_builtin');
    expect(trial.owning_layer).toBe('tool_scheduling');
  });
});

describe('scoped correctness gates for the unsent-field paired case', () => {
  it('replaces the bridge none-contract gate with a prompt-only scoped gate', () => {
    const noneCase = caseById('toolChoice_none');
    expect(pairedCorrectnessGateId(noneCase)).toBe('correctness.toolchoice_none_prompt_only');
    const gates = evaluateGates({
      profile: 'ci',
      cases: [noneCase],
      trials: [
        trialRecord('toolChoice_none', 'yorha', {
          failure_class: 'unexpected_tool',
          owning_layer: 'model_variance',
        }),
      ],
      paired: noPaired,
      isMeasured: allMeasured,
    });
    expect(gates.map((gate) => gate.id)).toEqual(['correctness.toolchoice_none_prompt_only']);
    expect(gates[0]?.status).toBe('pass');
    expect(gates[0]?.observed).toBe(0);
    expect(verdictFromGates(gates)).toBe('pass');
  });

  it('still fails the scoped gate on bridge-owned failures under the same case', () => {
    const gates = evaluateGates({
      profile: 'ci',
      cases: [caseById('toolChoice_none')],
      trials: [
        trialRecord('toolChoice_none', 'yorha', {
          failure_class: 'substituted_builtin',
          owning_layer: 'tool_scheduling',
        }),
      ],
      paired: noPaired,
      isMeasured: allMeasured,
    });
    expect(gates[0]?.id).toBe('correctness.toolchoice_none_prompt_only');
    expect(gates[0]?.status).toBe('fail');
    expect(gates[0]?.observed).toBe(1);
    expect(verdictFromGates(gates)).toBe('fail');
  });

  it('leaves other required correctness gates and thresholds untouched', () => {
    const gates = evaluateGates({
      profile: 'ci',
      cases: [caseById('text_sentinel_stream'), caseById('toolChoice_required')],
      trials: [
        trialRecord('text_sentinel_stream', 'native', {
          failure_class: 'sentinel_mismatch',
          owning_layer: 'model_variance',
        }),
        trialRecord('toolChoice_required', 'yorha', { passed: true }),
      ],
      paired: noPaired,
      isMeasured: allMeasured,
    });
    expect(gates.map((gate) => gate.id)).toEqual([
      'correctness.text_sentinel_stream',
      'correctness.toolchoice_required',
    ]);
    expect(gates[0]?.status).toBe('fail');
    expect(gates[1]?.status).toBe('pass');
  });
});

describe('runner-level contract for the unsent-field paired case', () => {
  it('records the spontaneous tool as a failed model-variance trial without failing the verdict', async () => {
    const noneCase = caseById('toolChoice_none');
    const result = await runBenchmark(
      {
        seed: SEED,
        profile: 'smoke',
        cases: [noneCase],
        dryRun: false,
      },
      {
        preflight: async () => ({
          ok: true,
          activeBackend: 'cursor-api',
          bridgeVersion: 'test',
          accountComparability: {
            status: 'unproved',
            method: 'none',
            reason: 'dry_run',
            identity_status: 'unproved',
            cryptographic_identity_proven: false,
            native_claim_available: false,
            bridge_claim_available: false,
            bridge_exchange_available: false,
            account_mismatch: true,
            latency_confounded: true,
          },
        }),
        executeTrial: async (request): Promise<LaneTrialSample> =>
          request.lane === 'yorha'
            ? spontaneousToolSample(request.sentinel, request.prompt, request.pairIndex * 10 + 1)
            : textSample(request.sentinel, request.prompt, request.pairIndex * 10 + 1),
      },
    );
    const failedYorha = result.evidence.trials.filter(
      (trial) => trial.lane === 'yorha' && !trial.passed,
    );
    expect(failedYorha.length).toBeGreaterThan(0);
    expect(
      failedYorha.every(
        (trial) =>
          trial.failure_class === 'unexpected_tool' && trial.owning_layer === 'model_variance',
      ),
    ).toBe(true);
    expect(
      result.evidence.gates.map((gate) => gate.id).includes('correctness.toolchoice_none'),
    ).toBe(false);
    expect(
      result.evidence.gates
        .filter((gate) => gate.id === 'correctness.toolchoice_none_prompt_only')
        .every((gate) => gate.status === 'pass'),
    ).toBe(true);
    expect(result.evidence.verdict).toBe('pass');
  });
});

describe('report surface disclosure', () => {
  it('discloses the prompt-only surface for every non-auto tool-choice case', async () => {
    const result = await runBenchmark(
      {
        seed: SEED,
        profile: 'smoke',
        cases: CASES,
        dryRun: true,
      },
      { executeTrial: () => Promise.reject(new Error('dry-run must not execute trials')) },
    );
    const markdown = renderMarkdownReport({
      evidence: result.evidence,
      schedule: result.schedule,
      isMeasured: isMeasuredTrialFactory(result.schedule),
    });
    expect(markdown).toContain('| toolChoice_none | none | false | prompt_only |');
    expect(markdown).toContain('| toolChoice_required | required | false | prompt_only |');
    expect(markdown).toContain('| toolChoice_forced | forced | false | prompt_only |');
  });
});
