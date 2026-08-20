import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeBenchmarkArtifacts } from '../src/benchmark/artifacts.js';
import { createCanonicalCases, sentinelFor } from '../src/benchmark/cases.js';
import type { BridgeHandle } from '../src/benchmark/bridge-process.js';
import { BridgeTraceCollector } from '../src/benchmark/bridge-trace.js';
import { sha256Hex } from '../src/benchmark/hash-json.js';
import { malformedProbe } from '../src/benchmark/malformed-probe.js';
import { runBenchmark } from '../src/benchmark/runner.js';
import { buildTrialPrompt, expectedCallsFor } from '../src/benchmark/schedule.js';
import { summarizeSessionDirectory } from '../src/benchmark/session-summary.js';

const roots: string[] = [];

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('benchmark evidence I/O integrity', () => {
  it('distinguishes an absent optional transcript from a missing session directory', async () => {
    // Given: one existing empty session directory and one missing directory.
    const root = await temporaryRoot('benchmark-session-absence-');
    const empty = join(root, 'empty');
    await mkdir(empty);

    // When: both session inputs are summarized.
    const absentTranscript = await summarizeSessionDirectory(empty);
    const missingDirectory = summarizeSessionDirectory(join(root, 'missing'));

    // Then: only the optional absent transcript maps to null.
    expect(absentTranscript).toBeNull();
    await expect(missingDirectory).rejects.toMatchObject({
      name: 'SessionSummaryError',
      code: 'read_directory',
    });
  });

  it.each([
    ['malformed JSONL', async (path: string) => writeFile(path, '{not-json}\n')],
    ['unreadable JSONL entry', async (path: string) => mkdir(path)],
  ] as const)('surfaces %s instead of returning an empty summary', async (_name, arrange) => {
    // Given: a discovered transcript entry that cannot be consumed honestly.
    const root = await temporaryRoot('benchmark-session-read-');
    const transcript = join(root, 'session.jsonl');
    await arrange(transcript);

    // When: the transcript summary is requested.
    const summary = summarizeSessionDirectory(root);

    // Then: evidence collection fails with a typed I/O classification.
    await expect(summary).rejects.toMatchObject({ name: 'SessionSummaryError' });
  });

  it('surfaces a malformed-probe response body read failure', async () => {
    // Given: a rejected malformed request whose response stream fails while being consumed.
    const testCase = createCanonicalCases().find((candidate) => candidate.id === 'malformed_json');
    if (testCase === undefined) throw new Error('missing malformed benchmark case');
    const sentinel = sentinelFor(testCase.id, 20260818, 0, 'yorha');
    const prompt = buildTrialPrompt(testCase, sentinel);
    const trace = new BridgeTraceCollector();
    const bridge: BridgeHandle = {
      port: 1,
      baseUrl: 'http://127.0.0.1:1',
      trace: () => trace.snapshot(),
      traceRecords: () => trace.records(),
      beginTraceScope: () => trace.beginScope(),
      cleanupReceipt: () => ({
        benchmark_owned_pid: null,
        close_observed: true,
        exit_code: 0,
        exit_signal: null,
      }),
      stop: async () => {},
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const body = new ReadableStream({
          start(controller) {
            controller.error(new Error('synthetic response read failure'));
          },
        });
        return new Response(body, { status: 400 });
      }),
    );

    // When: the malformed-input observation consumes the response.
    const observation = malformedProbe(
      { bridge },
      {
        testCase,
        pairIndex: 0,
        phase: 'measured',
        lane: 'yorha',
        sentinel,
        peerSentinels: [],
        prompt,
        promptHash: sha256Hex(prompt),
        expectedCalls: expectedCallsFor(testCase, sentinel),
        omoSeed: 'evidence-io',
        concurrency: 1,
        signal: new AbortController().signal,
      },
    );

    // Then: the read failure is typed instead of becoming an empty successful body.
    await expect(observation).rejects.toMatchObject({
      name: 'MalformedProbeError',
      code: 'response_body_read_failed',
    });
  });

  it('fails artifact generation when cleanup state cannot be observed', async () => {
    // Given: dry-run evidence and a temp-root path that is a file, not a directory.
    const root = await temporaryRoot('benchmark-cleanup-observation-');
    const tempRoot = join(root, 'not-a-directory');
    await writeFile(tempRoot, 'fixture');
    const testCase = createCanonicalCases().find(
      (candidate) => candidate.id === 'text_sentinel_stream',
    );
    if (testCase === undefined) throw new Error('missing text sentinel benchmark case');
    const result = await runBenchmark(
      {
        seed: 20260818,
        profile: 'smoke',
        cases: [testCase],
        dryRun: true,
        companionFiles: [
          { kind: 'bridge_trace', path: 'result.bridge-trace.jsonl' },
          { kind: 'versions_environment', path: 'result.versions-environment.json' },
          { kind: 'command_exit', path: 'result.command-exit.json' },
          { kind: 'cleanup', path: 'result.cleanup.json' },
        ],
      },
      {
        executeTrial: async () => {
          throw new Error('dry run must not execute trials');
        },
      },
    );

    // When: the cleanup receipt attempts to inspect that path.
    const write = writeBenchmarkArtifacts(join(root, 'result.json'), result, {
      traceRecords: [],
      bridgeCleanup: null,
      exitCode: 0,
      tempRoot,
    });

    // Then: no successful zero-remaining cleanup observation is fabricated.
    await expect(write).rejects.toMatchObject({
      name: 'ArtifactIoError',
      code: 'cleanup_observation_failed',
    });
  });
});
