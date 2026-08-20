import { describe, expect, it } from 'vitest';
import { createCanonicalCases } from '../src/benchmark/cases.js';
import { sha256Hex } from '../src/benchmark/normalize.js';
import {
  assembleTrialRecord,
  type LaneTrialRequest,
  type LaneTrialSample,
} from '../src/benchmark/trial-record.js';

const testCase = createCanonicalCases().find(
  (candidate) => candidate.id === 'text_sentinel_stream',
);
if (!testCase) throw new Error('missing text benchmark case');
const sentinel = 'BENCH_TEXT_SENTINEL_STREAM_YORHA_ABCDEF123456';
const prompt = `return ${sentinel}`;
const request: LaneTrialRequest = {
  testCase,
  pairIndex: 0,
  phase: 'measured',
  lane: 'yorha',
  sentinel,
  peerSentinels: [],
  prompt,
  promptHash: sha256Hex(prompt),
  expectedCalls: [],
  omoSeed: 'task-11-backend-flip',
  concurrency: 1,
  signal: new AbortController().signal,
};

function sample(finalBackend: string): LaneTrialSample {
  return {
    rawEvents: [
      { type: 'agent_start', atMs: 0 },
      { type: 'text_delta', delta: sentinel, atMs: 1 },
      { type: 'agent_end', atMs: 2 },
    ],
    durationMs: 2,
    upstreamRuns: 1,
    failureClass: null,
    promptHash: request.promptHash,
    httpStatus: null,
    isolatedSentinels: null,
    traceJoin: {
      sequence_start: 1,
      sequence_end: 3,
      request_ids: ['req-task-11-backend'],
      record_count: 3,
      attributed_run_count: 1,
      retry_count: 0,
      retry_reasons: [],
      active_backend: 'cursor-api',
      usage_source: 'unknown',
      final_backend_state: finalBackend,
      cancelled: false,
      quiescent: true,
      synchronized: true,
    },
    childReport: { diagnostics: '', exits: [], session: null },
  };
}

describe('task 11 benchmark backend pin', () => {
  it('classifies a mid-request backend change as backend_flip even when content passes', () => {
    expect(assembleTrialRecord(request, sample('cursor-cli'))).toMatchObject({
      passed: false,
      failure_class: 'backend_flip',
      owning_layer: 'backend_routing',
    });
  });

  it('accepts a cursor-api request that remains pinned', () => {
    expect(assembleTrialRecord(request, sample('cursor-api'))).toMatchObject({
      passed: true,
      failure_class: null,
    });
  });

  it('accepts a rejected malformed request with no backend trace or upstream Run', () => {
    // Given: malformed input is rejected before backend selection.
    const malformedCase = createCanonicalCases().find(
      (candidate) => candidate.id === 'malformed_duplicate_tool_call_ids',
    );
    if (!malformedCase) throw new Error('missing malformed benchmark case');
    const malformedRequest: LaneTrialRequest = {
      ...request,
      testCase: malformedCase,
      promptHash: sha256Hex('malformed probe'),
    };
    const malformedSample: LaneTrialSample = {
      ...sample('cursor-api'),
      rawEvents: [
        { type: 'agent_start', atMs: 0 },
        { type: 'agent_end', atMs: 1 },
      ],
      durationMs: 1,
      upstreamRuns: 0,
      promptHash: null,
      httpStatus: 400,
      traceJoin: {
        sequence_start: null,
        sequence_end: null,
        request_ids: [],
        record_count: 0,
        attributed_run_count: 0,
        retry_count: 0,
        retry_reasons: [],
        active_backend: null,
        usage_source: 'unknown',
        final_backend_state: null,
        cancelled: false,
        quiescent: false,
        synchronized: true,
      },
    };

    // When: the benchmark assembles the malformed-input trial.
    const record = assembleTrialRecord(malformedRequest, malformedSample);

    // Then: absence of a selected backend is not classified as a flip.
    expect(record).toMatchObject({ passed: true, failure_class: null, upstream_runs: 0 });
  });
});
