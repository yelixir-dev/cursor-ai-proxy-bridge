import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  classifyModelVisibleAssistantEvent,
  createCancellationTrigger,
} from '../src/benchmark/cancellation.js';
import { createCanonicalCases } from '../src/benchmark/cases.js';
import { makeExecutor } from '../src/benchmark/executor.js';
import { sha256Hex } from '../src/benchmark/normalize.js';
import { assembleTrialRecord, type LaneTrialRequest } from '../src/benchmark/trial-record.js';
import type { BridgeHandle } from '../src/benchmark/bridge-process.js';
import type { TimedOmoEvent } from '../src/benchmark/omo-process.js';
import { requireValue } from './support/strict-accessors.js';

const event = (value: Record<string, unknown>): TimedOmoEvent => ({
  atMs: 1,
  value: value as TimedOmoEvent['value'],
});

describe('symmetric model-visible cancellation', () => {
  it.each([
    { type: 'agent_start' },
    { type: 'session' },
    { type: 'status' },
    { type: 'custom' },
    { type: 'thinking_start' },
    { type: 'thinking_delta', delta: 'private prelude' },
    { type: 'message_end', message: { role: 'custom', content: 'onboarding' } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '' } },
  ])('ignores lifecycle, prelude, and non-content event %#', (value) => {
    expect(classifyModelVisibleAssistantEvent(event(value))).toBeNull();
  });

  it.each([
    [
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'x' } },
      'content',
    ],
    [{ type: 'message_end', message: { role: 'assistant', content: 'x' } }, 'content'],
    [
      { type: 'message_update', assistantMessageEvent: { type: 'toolcall_start' } },
      'tool_decision',
    ],
    [{ type: 'toolcall_delta', delta: '{' }, 'tool_decision'],
    [
      { type: 'message_end', message: { role: 'assistant', tool_calls: [{ id: 'safe' }] } },
      'tool_decision',
    ],
  ] as const)('classifies model-visible event %#', (value, expected) => {
    expect(classifyModelVisibleAssistantEvent(event(value))).toBe(expected);
  });

  it('reproduces the native predecessor without cancelling on agent_start and cancels once on content', async () => {
    const abort = vi.fn();
    const barrier = { waitForSynchronizedRunOpen: vi.fn(async () => true) };
    const trigger = createCancellationTrigger({
      lane: 'native',
      after: 'first_event',
      timeoutMs: 20,
      abort,
      barrier,
    });
    trigger.onEvent(event({ type: 'agent_start' }));
    expect(abort).not.toHaveBeenCalled();
    trigger.onEvent(
      event({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'x' } }),
    );
    trigger.onEvent(event({ type: 'toolcall_start' }));
    await trigger.settle();
    expect(abort).toHaveBeenCalledTimes(1);
    expect(barrier.waitForSynchronizedRunOpen).not.toHaveBeenCalled();
    expect(trigger.outcome()).toBe('cancel_sent');
  });

  it('holds yorha cancellation until the attributable run_open barrier resolves', async () => {
    const gate = Promise.withResolvers<boolean>();
    const abort = vi.fn();
    const barrier = { waitForSynchronizedRunOpen: vi.fn(() => gate.promise) };
    const trigger = createCancellationTrigger({
      lane: 'yorha',
      after: 'first_event',
      timeoutMs: 20,
      abort,
      barrier,
    });
    trigger.onEvent(
      event({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'x' } }),
    );
    expect(trigger.outcome()).toBe('waiting_for_run_open');
    expect(abort).not.toHaveBeenCalled();
    gate.resolve(true);
    await trigger.settle();
    expect(abort).toHaveBeenCalledTimes(1);
    expect(trigger.outcome()).toBe('cancel_sent');
  });

  it('classifies a missing synchronized run_open as a bounded barrier timeout without aborting', async () => {
    const abort = vi.fn();
    const barrier = { waitForSynchronizedRunOpen: vi.fn(async () => false) };
    const trigger = createCancellationTrigger({
      lane: 'yorha',
      after: 'first_event',
      timeoutMs: 20,
      abort,
      barrier,
    });
    trigger.onEvent(event({ type: 'text_delta', delta: 'x' }));
    await trigger.settle();
    expect(abort).not.toHaveBeenCalled();
    expect(trigger.outcome()).toBe('barrier_timeout');
  });

  it('replays the trial-78 native/yorha pair through the executor with no paid traffic', async () => {
    const root = await mkdtemp(join(tmpdir(), 'benchmark-cancel-r7-'));
    try {
      const executable = join(root, 'fake-omo.mjs');
      await writeFile(
        executable,
        `#!/usr/bin/env node
import { createServer } from 'node:net';
const args = process.argv.slice(2);
const newline = String.fromCharCode(10);
if (args.includes('--version')) process.stdout.end('omo 5.0.0-0.beta.9 (engine: senpi 2026.8.17)' + newline);
else if (args.includes('--list-models')) process.stdout.end([
  'provider model context max-out thinking images',
  'cursor composer-2.5 200K 64K no no',
  'cursor composer-2.5-fast 200K 64K no no',
].join(newline) + newline);
else {
  process.stdin.resume();
  process.stdin.once('end', () => {
    const keeper = createServer();
    keeper.listen(0, '127.0.0.1', () => {
      process.stdout.write('{"type":"agent_start"}' + newline);
      process.stdout.write('{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"visible"}}' + newline);
    });
    process.once('SIGTERM', () => keeper.close(() => process.exit(0)));
  });
}
`,
      );
      await chmod(executable, 0o755);
      const authStorePath = join(root, 'auth.json');
      const modelStorePath = join(root, 'models-store.json');
      await writeFile(
        authStorePath,
        JSON.stringify({
          cursor: {
            type: 'oauth',
            access: 'fixture-access',
            refresh: 'fixture-refresh',
            expires: 4_102_444_800_000,
          },
        }),
        { mode: 0o600 },
      );
      await writeFile(
        modelStorePath,
        JSON.stringify({
          cursor: { models: [{ provider: 'cursor', id: 'composer-2.5' }] },
        }),
        { mode: 0o600 },
      );
      const bridge: BridgeHandle = {
        port: 1,
        baseUrl: 'http://127.0.0.1:1',
        trace: () => ({ runOpens: 1, flips: 0 }),
        traceRecords: () => [],
        beginTraceScope: () => ({
          snapshot: () => ({ runOpens: 1, flips: 0 }),
          waitForRunOpen: async () => true,
          waitForSynchronizedRunOpen: async () => true,
          subscribeBackendChange: () => () => undefined,
          finish: async () => ({
            sequence_start: 1,
            sequence_end: 1,
            request_ids: ['req-cancel-r7'],
            record_count: 1,
            attributed_run_count: 1,
            synchronized: true,
          }),
        }),
        cleanupReceipt: () => ({
          benchmark_owned_pid: null,
          close_observed: true,
          exit_code: 0,
          exit_signal: null,
        }),
        stop: async () => undefined,
      };
      const testCase = requireValue(
        createCanonicalCases().find((candidate) => candidate.id === 'cancel_after_first_event'),
        'canonical case cancel_after_first_event',
      );
      const execute = makeExecutor({
        bridge,
        authStorePath,
        modelStorePath,
        omoBin: executable,
        trialTimeoutMs: 5_000,
        cancellationBarrierTimeoutMs: 1_000,
        tempRoot: root,
        signal: new AbortController().signal,
      });
      for (const lane of ['native', 'yorha'] as const) {
        const prompt = 'cancel after visible content';
        const request: LaneTrialRequest = {
          testCase,
          pairIndex: 0,
          phase: 'warmup',
          lane,
          sentinel: 'BENCH_CANCEL_R7',
          peerSentinels: [],
          prompt,
          promptHash: sha256Hex(prompt),
          expectedCalls: [],
          omoSeed: `r7-${lane}`,
          concurrency: 1,
          signal: new AbortController().signal,
        };
        const sample = await execute(request);
        expect(sample.failureClass).toBeNull();
        expect(sample.upstreamRuns).toBe(lane === 'yorha' ? 1 : 0);
        expect(assembleTrialRecord(request, sample)).toMatchObject({
          passed: true,
          failure_class: null,
          upstream_runs: lane === 'yorha' ? 1 : 0,
        });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('requires a tool decision for the mid-tool arm', async () => {
    const abort = vi.fn();
    const trigger = createCancellationTrigger({
      lane: 'native',
      after: 'tool_decision',
      timeoutMs: 20,
      abort,
      barrier: { waitForSynchronizedRunOpen: vi.fn(async () => true) },
    });
    trigger.onEvent(event({ type: 'text_delta', delta: 'visible' }));
    expect(abort).not.toHaveBeenCalled();
    trigger.onEvent(event({ type: 'toolcall_start' }));
    await trigger.settle();
    expect(abort).toHaveBeenCalledTimes(1);
  });
});
