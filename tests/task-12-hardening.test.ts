import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BridgeHandle } from '../src/benchmark/bridge-process.js';
import { createCanonicalCases } from '../src/benchmark/cases.js';
import { makeExecutor } from '../src/benchmark/executor.js';
import { sha256Hex } from '../src/benchmark/normalize.js';
import { buildTrialPrompt } from '../src/benchmark/schedule.js';
import type { LaneTrialRequest } from '../src/benchmark/trial-record.js';

const FAKE_OMO = (port: number): string => `#!/usr/bin/env node
import { connect } from 'node:net';
const args = process.argv.slice(2);
const newline = String.fromCharCode(10);
if (args.includes('--version')) {
  process.stdout.end('omo 5.0.0-0.beta.9 (engine: senpi 2026.8.17)' + newline);
} else if (args.includes('--list-models')) {
  process.stdout.end('cursor composer-2.5 200K 64K no no' + newline);
} else {
  let socket;
  process.once('SIGTERM', () => socket.end('ABORT' + newline, () => process.exit(0)));
  process.stdin.resume();
  process.stdin.once('end', () => {
    socket = connect(${port}, '127.0.0.1', () => socket.write('READY' + newline));
    socket.on('data', (chunk) => {
      if (!chunk.toString('utf8').includes('GO')) return;
      process.stdout.write('{"type":"agent_start"}' + newline);
      process.stdout.write('{"type":"message_end","message":{"role":"assistant","content":"completed","stopReason":"stop"}}' + newline);
      process.stdout.write('{"type":"agent_end"}' + newline);
      socket.end('COMPLETE' + newline, () => process.exit(0));
    });
  });
}
`;

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let complete = (_value: T): void => {
    throw new Error('deferred promise initialized without a resolver');
  };
  const promise = new Promise<T>((resolve) => {
    complete = resolve;
  });
  return { promise, resolve: complete };
}

async function observedWithin(signal: Promise<void>, timeoutMs: number): Promise<boolean> {
  const deadline = AbortSignal.timeout(timeoutMs);
  return Promise.race([
    signal.then(() => true),
    new Promise<false>((resolve) => {
      deadline.addEventListener('abort', () => resolve(false), { once: true });
    }),
  ]);
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe('task 12 lifecycle hardening', () => {
  it('aborts the in-flight OMO child immediately when the scoped backend flips', async () => {
    // Given: a real executor trial child that blocks on an explicit completion release.
    const root = await mkdtemp(join(tmpdir(), 'task-12-backend-flip-'));
    const ready = deferred();
    const aborted = deferred();
    const sockets = new Set<Socket>();
    let trialSocket: Socket | undefined;
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        if (chunk.includes('READY')) {
          trialSocket = socket;
          ready.resolve();
        }
        if (chunk.includes('ABORT')) aborted.resolve();
      });
      socket.once('close', () => sockets.delete(socket));
    });
    const external = new AbortController();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('missing test port');
      const executable = join(root, 'fake-omo.mjs');
      await writeFile(executable, FAKE_OMO(address.port), { mode: 0o755 });
      await chmod(executable, 0o755);
      const authStorePath = join(root, 'auth.json');
      const modelStorePath = join(root, 'models-store.json');
      await Promise.all([
        writeFile(
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
        ),
        writeFile(
          modelStorePath,
          JSON.stringify({ cursor: { models: [{ provider: 'cursor', id: 'composer-2.5' }] } }),
          { mode: 0o600 },
        ),
      ]);
      let backendFlip: (() => void) | undefined;
      let flipObserved = false;
      const bridge: BridgeHandle = {
        port: 1,
        baseUrl: 'http://127.0.0.1:1',
        trace: () => ({ runOpens: 0, flips: flipObserved ? 1 : 0 }),
        traceRecords: () => [],
        beginTraceScope: () => ({
          snapshot: () => ({ runOpens: 0, flips: flipObserved ? 1 : 0 }),
          waitForRunOpen: async () => false,
          waitForSynchronizedRunOpen: async () => false,
          subscribeBackendChange: (listener) => {
            backendFlip = listener;
            return () => {
              backendFlip = undefined;
            };
          },
          finish: async () => ({
            sequence_start: null,
            sequence_end: null,
            request_ids: [],
            record_count: 0,
            attributed_run_count: 0,
            active_backend: 'cursor-api',
            final_backend_state: 'cursor-cli',
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
      const testCase = createCanonicalCases().find(
        (candidate) => candidate.id === 'text_sentinel_stream',
      );
      if (!testCase) throw new Error('missing canonical text case');
      const sentinel = 'TASK_12_BACKEND_FLIP';
      const prompt = buildTrialPrompt(testCase, sentinel);
      const request: LaneTrialRequest = {
        testCase,
        pairIndex: 0,
        phase: 'warmup',
        lane: 'yorha',
        sentinel,
        peerSentinels: [],
        prompt,
        promptHash: sha256Hex(prompt),
        expectedCalls: [],
        omoSeed: 'task-12-backend-flip',
        concurrency: 1,
        signal: external.signal,
      };
      const execution = makeExecutor({
        bridge,
        authStorePath,
        modelStorePath,
        omoBin: executable,
        trialTimeoutMs: 5_000,
        tempRoot: root,
        signal: external.signal,
      })(request);
      await ready.promise;

      // When: the trace scope reports a backend flip while that child is blocked.
      flipObserved = true;
      backendFlip?.();
      const abortedBeforeRelease = await observedWithin(aborted.promise, 2_000);
      if (!abortedBeforeRelease) trialSocket?.write('GO\n');
      const sample = await execution;

      // Then: the child acknowledges abort before any successful event can be emitted.
      expect(abortedBeforeRelease).toBe(true);
      expect(sample.failureClass).toBe('backend_flip');
      expect(sample.rawEvents).toEqual([]);
    } finally {
      external.abort();
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
      await rm(root, { recursive: true, force: true });
    }
  });
});
