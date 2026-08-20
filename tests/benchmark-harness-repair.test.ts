import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { unprovedAccountComparability } from '../src/benchmark/account-comparability.js';
import {
  startBridge,
  type BridgeSpawn,
  type SanitizedBridgeTraceRecord,
} from '../src/benchmark/bridge-process.js';
import { createCanonicalCases } from '../src/benchmark/cases.js';
import { createBenchmarkFixture, omoTrialArgs } from '../src/benchmark/fixture.js';
import { runBenchmark } from '../src/benchmark/runner.js';
import { validateRetainedTraceJoins } from '../src/benchmark/trace-join.js';
import type { LaneTrialSample } from '../src/benchmark/trial-record.js';
import { requireValue } from './support/strict-accessors.js';

const emptyTrialChild = () => ({ diagnostics: '', exits: [], session: null });

class TraceChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 81_001;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signalCode = signal;
    this.emit('exit', null, signal);
    this.emit('close', null, signal);
    return true;
  }
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('repaired benchmark evidence contract', () => {
  it('retains only sanitized bridge trace fields and attributes scoped Runs', async () => {
    const spawnedChildren: TraceChild[] = [];
    const spawnImpl: BridgeSpawn = (_command, _args, _options: SpawnOptions) => {
      const child = new TraceChild();
      spawnedChildren.push(child);
      queueMicrotask(() => child.stdout.write('cursor-ai-bridge listening on local\n'));
      return child as unknown as ChildProcess;
    };
    const bridge = await startBridge('/entry.js', { spawnImpl });
    const child = spawnedChildren[0];
    if (child === undefined) throw new Error('spawnImpl must capture the bridge child');
    const scope = bridge.beginTraceScope();
    child.stderr.write(
      '{"request_id":"req-1","credential_slot_id":"slot-safe","backend":"cursor-api","model":"composer-2.5","upstream_run_count":1,"retry_count":0,"stage":"run_open","offset_ms":2}\n',
    );
    child.stderr.write(
      '{"request_id":"req-1","credential_slot_id":"slot-safe","backend":"cursor-api","model":"composer-2.5","upstream_run_count":1,"retry_count":0,"stage":"terminal","offset_ms":3,"usage_source":"turnEnded","final_backend_state":"cursor-api","cancelled":false,"quiescent":true,"terminal":"success"}\n',
    );

    const joined = await scope.finish();
    expect(joined).toEqual({
      sequence_start: 1,
      sequence_end: 2,
      request_ids: ['req-1'],
      record_count: 2,
      attributed_run_count: 1,
      retry_count: 0,
      retry_reasons: [],
      active_backend: 'cursor-api',
      usage_source: 'turnEnded',
      final_backend_state: 'cursor-api',
      cancelled: false,
      quiescent: true,
      synchronized: true,
    });
    expect(scope.snapshot().runOpens).toBe(1);
    expect(bridge.traceRecords()).toEqual<SanitizedBridgeTraceRecord[]>([
      {
        sequence: 1,
        request_id: 'req-1',
        credential_slot_id: 'slot-safe',
        backend: 'cursor-api',
        model: 'composer-2.5',
        upstream_run_count: 1,
        retry_count: 0,
        stage: 'run_open',
        offset_ms: 2,
      },
      {
        sequence: 2,
        request_id: 'req-1',
        credential_slot_id: 'slot-safe',
        backend: 'cursor-api',
        model: 'composer-2.5',
        upstream_run_count: 1,
        retry_count: 0,
        stage: 'terminal',
        offset_ms: 3,
        usage_source: 'turnEnded',
        final_backend_state: 'cursor-api',
        cancelled: false,
        quiescent: true,
        terminal: 'success',
      },
    ]);
    expect(JSON.stringify(bridge.traceRecords())).not.toMatch(/prompt|arguments|result|output/i);
    await bridge.stop();
  });

  it('infra-classifies a completed yorha sample with no attributable bridge Run', async () => {
    const testCase = createCanonicalCases().find(
      (candidate) => candidate.id === 'text_sentinel_stream',
    );
    if (!testCase) throw new Error('missing text benchmark case');
    const result = await runBenchmark(
      { seed: 20260818, profile: 'smoke', cases: [testCase], dryRun: false },
      {
        preflight: async () => ({
          ok: true,
          activeBackend: 'cursor-api',
          bridgeVersion: '0.1.0',
          accountComparability: unprovedAccountComparability('bridge_credential_missing'),
        }),
        executeTrial: async (request): Promise<LaneTrialSample> => ({
          rawEvents: [
            { type: 'agent_start', atMs: 0 },
            { type: 'text_delta', delta: request.sentinel, atMs: 1 },
            { type: 'agent_end', atMs: 2 },
          ],
          durationMs: 2,
          upstreamRuns: request.lane === 'yorha' ? 0 : 1,
          failureClass: null,
          promptHash: null,
          httpStatus: null,
          isolatedSentinels: null,
          traceJoin:
            request.lane === 'yorha'
              ? {
                  sequence_start: request.pairIndex * 10 + 1,
                  sequence_end: request.pairIndex * 10 + 2,
                  request_ids: [`req-text-${request.pairIndex}`],
                  record_count: 2,
                  attributed_run_count: 0,
                  synchronized: true,
                }
              : null,
          childReport: emptyTrialChild(),
        }),
      },
    );

    const zeroRun = result.evidence.trials.find(
      (trial) => trial.lane === 'yorha' && trial.upstream_runs === 0,
    );
    expect(zeroRun?.failure_class).toBe('infra_fail');
    expect(result.evidence.verdict).toBe('infra_fail');
  });

  it('installs only the canonical deterministic tools in every isolated OMO fixture', async () => {
    const root = await mkdtemp(join(tmpdir(), 'benchmark-tools-test-'));
    roots.push(root);
    const identityStorePath = join(root, 'identity.json');
    const modelStorePath = join(root, 'models-store.json');
    await writeFile(
      identityStorePath,
      JSON.stringify({
        cursor: {
          type: 'oauth',
          access: 'fixture-access',
          refresh: 'fixture-refresh',
          expires: 4_102_444_800_000,
        },
      }),
    );
    await writeFile(
      modelStorePath,
      JSON.stringify({
        cursor: { models: [{ provider: 'cursor', id: 'composer-2.5' }] },
      }),
    );
    const fixture = await createBenchmarkFixture({
      authStorePath: identityStorePath,
      modelStorePath,
      bridgeBaseUrl: 'http://127.0.0.1:9911/v1',
      tempRoot: root,
    });

    const extension = await readFile(fixture.toolExtensionPath, 'utf8');
    expect(extension).toContain('name: "echo_value"');
    expect(extension).toContain('name: "lookup_code"');
    expect(extension).not.toMatch(/bash|read_file|write_file/i);
    expect(omoTrialArgs('cursor', 'composer-2.5', fixture, 'seed-1')).toEqual(
      expect.arrayContaining([
        '--extension',
        fixture.toolExtensionPath,
        '--no-extensions',
        '--no-builtin-tools',
        '--tools',
        'echo_value,lookup_code',
      ]),
    );
    await fixture.dispose();
  });

  it('invalidates a stale primary and companion set before startup can fail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'benchmark-stale-test-'));
    roots.push(root);
    const output = join(root, 'stale.json');
    const stale = [
      output,
      join(root, 'stale.md'),
      join(root, 'stale.bridge-trace.jsonl'),
      join(root, 'stale.versions-environment.json'),
      join(root, 'stale.command-exit.json'),
      join(root, 'stale.cleanup.json'),
    ];
    await Promise.all(stale.map((path) => writeFile(path, 'STALE_PASS')));
    const artifacts = await import('../src/benchmark/artifacts.js');
    const invalidate = Reflect.get(artifacts, 'invalidateBenchmarkArtifacts');
    expect(typeof invalidate).toBe('function');
    await invalidate(output);
    await expect(Promise.all(stale.map((path) => readFile(path, 'utf8')))).rejects.toThrow();
  });

  it('replaces stale success artifacts with one explicit startup failure receipt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'benchmark-failure-receipt-test-'));
    roots.push(root);
    const output = join(root, 'failed.json');
    const staleMarkdown = join(root, 'failed.md');
    await Promise.all([writeFile(output, '{"verdict":"pass"}'), writeFile(staleMarkdown, 'pass')]);
    const artifacts = await import('../src/benchmark/artifacts.js');
    const path = await artifacts.writeBenchmarkFailureReceipt(output, 5, 'bridge_start');
    const receipt = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    expect(receipt).toMatchObject({
      completed: true,
      exit_code: 5,
      verdict: 'infra_fail',
      stage: 'bridge_start',
    });
    await expect(readFile(output, 'utf8')).rejects.toThrow();
    await expect(readFile(staleMarkdown, 'utf8')).rejects.toThrow();
  });

  it('emits machine-consumed companions and canonical tool receipts', async () => {
    const testCase = createCanonicalCases().find(
      (candidate) => candidate.id === 'tool_auto_single',
    );
    if (!testCase) throw new Error('missing tool benchmark case');
    const result = await runBenchmark(
      { seed: 20260818, profile: 'smoke', cases: [testCase], dryRun: false },
      {
        preflight: async () => ({
          ok: true,
          activeBackend: 'cursor-api',
          bridgeVersion: '0.1.0',
          accountComparability: unprovedAccountComparability('bridge_credential_missing'),
        }),
        executeTrial: async (request): Promise<LaneTrialSample> => ({
          rawEvents: [
            { type: 'agent_start', atMs: 0 },
            {
              type: 'toolcall_end',
              atMs: 1,
              toolCall: {
                id: 'safe-call',
                function: {
                  name: 'echo_value',
                  arguments: JSON.stringify({ value: request.sentinel }),
                },
              },
            },
            {
              type: 'tool_execution_end',
              atMs: 2,
              toolCallId: 'safe-call',
              toolName: 'echo_value',
              isError: false,
            },
            { type: 'text_delta', delta: request.sentinel, atMs: 3 },
            { type: 'agent_end', atMs: 4 },
          ],
          durationMs: 4,
          upstreamRuns: 1,
          failureClass: null,
          promptHash: null,
          httpStatus: null,
          isolatedSentinels: null,
          traceJoin:
            request.lane === 'yorha'
              ? {
                  sequence_start: request.pairIndex * 10 + 1,
                  sequence_end: request.pairIndex * 10 + 2,
                  request_ids: [`req-tool-${request.pairIndex}`],
                  record_count: 2,
                  attributed_run_count: 1,
                  synchronized: true,
                }
              : null,
          childReport: emptyTrialChild(),
        }),
      },
    );

    expect(result.evidence.companions.account_mismatch).toBe(true);
    expect(result.evidence.companions.latency_confounded).toBe(true);
    expect(result.evidence.companions.files.map((file) => file.kind)).toEqual([
      'bridge_trace',
      'versions_environment',
      'command_exit',
      'cleanup',
    ]);
    expect(result.evidence.trials[0]?.canonical_tool_calls).toEqual([
      { call_index: 0, name: 'echo_value', executed: true },
    ]);
    const retained = result.evidence.trials
      .filter((trial) => trial.lane === 'yorha')
      .flatMap((trial) => {
        const join = trial.trace_join;
        if (join?.sequence_start === null || join?.sequence_end === null || !join) return [];
        return [
          {
            sequence: join.sequence_start,
            request_id: join.request_ids[0],
            credential_slot_id: null,
            backend: 'cursor-api' as const,
            model: 'composer-2.5',
            upstream_run_count: 0,
            stage: 'accepted',
            offset_ms: 0,
          },
          {
            sequence: join.sequence_end,
            request_id: join.request_ids[0],
            credential_slot_id: null,
            backend: 'cursor-api' as const,
            model: 'composer-2.5',
            upstream_run_count: 1,
            stage: 'run_open',
            offset_ms: 1,
          },
        ];
      });
    expect(() => validateRetainedTraceJoins(result.evidence, retained)).not.toThrow();
    expect(() =>
      validateRetainedTraceJoins(result.evidence, [
        ...retained.slice(0, -1),
        { ...requireValue(retained.at(-1), 'retained trace records'), request_id: 'wrong-request' },
      ]),
    ).toThrow('do not match trial attribution');
  });
});
