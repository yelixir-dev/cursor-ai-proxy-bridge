import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createTraceProvenance,
  sanitizeTraceLine,
  triggerAndAwaitAbortQuiescence,
  serverEnvironment,
} from '../src/e2e/trace-provenance.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('pinned E2E bridge trace provenance', () => {
  it('enables bridge tracing in the server environment while preserving caller values', () => {
    const env = serverEnvironment(
      {
        CURSOR_BRIDGE_BACKEND: 'cursor-api',
        CURSOR_BRIDGE_CURSOR_BIN: 'cursor-agent',
        UNRELATED: 'kept',
      },
      {
        CURSOR_BRIDGE_HOST: '127.0.0.1',
        CURSOR_BRIDGE_PORT: '43121',
        CURSOR_BRIDGE_API_KEY: 'test',
      },
    );
    expect(env.CURSOR_BRIDGE_TRACE).toBe('1');
    expect(env.CURSOR_BRIDGE_BACKEND).toBe('cursor-api');
    expect(env.CURSOR_BRIDGE_PORT).toBe('43121');
    expect(env.UNRELATED).toBe('kept');
  });

  it('keeps only trace-shaped records and scrubs secret-looking field values', () => {
    expect(sanitizeTraceLine(JSON.stringify({ stage: 'accepted', request_id: 'req-1' }))).toEqual({
      stage: 'accepted',
      request_id: 'req-1',
    });
    expect(sanitizeTraceLine('not json')).toBeNull();
    expect(sanitizeTraceLine(JSON.stringify({ hello: 'world' }))).toBeNull();
    expect(
      sanitizeTraceLine(JSON.stringify({ stage: 'not_a_stage', request_id: 'req-1' })),
    ).toBeNull();
    expect(
      sanitizeTraceLine(
        JSON.stringify({ stage: 'accepted', request_id: 'Bearer secret-token-12345678' }),
      ),
    ).toMatchObject({ request_id: 'Bearer [redacted]' });
  });

  it('writes a sanitized trace and receipt into a task-owned temp path and retains them on failure', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'e2e-trace-provenance-'));
    roots.push(tempRoot);
    const provenance = await createTraceProvenance({ tempRoot });
    expect(provenance.root.startsWith(tempRoot)).toBe(true);
    provenance.ingest(
      JSON.stringify({ stage: 'accepted', request_id: 'req-1', model: 'composer-2.5' }),
    );
    provenance.ingest('plain bridge diagnostic');
    provenance.ingest(JSON.stringify({ unrelated: 'json' }));
    provenance.ingest(
      JSON.stringify({
        stage: 'run_open',
        request_id: 'Bearer secret-token-12345678',
        backend: 'cursor-api',
      }),
    );
    const receipt = await provenance.finish({ failed: true });
    expect(receipt).toMatchObject({
      schema_version: 'cursor-e2e-trace-receipt/v1',
      record_count: 2,
      stage_counts: { accepted: 1, run_open: 1 },
      request_id_count: 2,
      run_open_count: 1,
      retained: true,
    });
    const trace = await readFile(provenance.tracePath, 'utf8');
    const records = trace
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { stage: string });
    expect(records.map((record) => record.stage)).toEqual(['accepted', 'run_open']);
    expect(trace).not.toContain('secret-token-12345678');
    expect(trace).toContain('Bearer [redacted]');
    const receiptJson = JSON.parse(await readFile(provenance.receiptPath, 'utf8'));
    expect(receiptJson.schema_version).toBe('cursor-e2e-trace-receipt/v1');
    expect(JSON.stringify(receiptJson)).not.toContain('secret-token-12345678');
  });

  it('subscribes to abort quiescence before triggering client abort', async () => {
    // Given: a trace collector and a cancellation signal that fires after synchronous ingestion.
    const tempRoot = await mkdtemp(join(tmpdir(), 'e2e-trace-subscription-'));
    roots.push(tempRoot);
    const provenance = await createTraceProvenance({ tempRoot });
    const controller = new AbortController();

    // When: the trigger emits quiescence immediately, before its promise continuation.
    const record = await triggerAndAwaitAbortQuiescence({
      provenance,
      signal: controller.signal,
      trigger: async () => {
        provenance.ingest(
          JSON.stringify({
            stage: 'terminal',
            request_id: 'req-abort',
            terminal: 'abort',
            quiescent: true,
          }),
        );
        queueMicrotask(() => controller.abort());
      },
    });

    // Then: the pre-established exact subscription wins the missed-event race.
    expect(record).toMatchObject({
      stage: 'terminal',
      request_id: 'req-abort',
      terminal: 'abort',
      quiescent: true,
    });
  });

  it('cancels an unmet trace subscription without sleeps or polling', async () => {
    // Given: an exact future-record subscription.
    const tempRoot = await mkdtemp(join(tmpdir(), 'e2e-trace-cancel-'));
    roots.push(tempRoot);
    const provenance = await createTraceProvenance({ tempRoot });
    const controller = new AbortController();
    const waiting = provenance.waitForRecord(() => true, controller.signal);

    // When: its bounded caller cancellation fires.
    controller.abort();

    // Then: the subscription rejects immediately instead of polling state.
    await expect(waiting).rejects.toThrow();
  });

  it('cleans the task-owned trace directory after a successful run', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'e2e-trace-cleanup-'));
    roots.push(tempRoot);
    const provenance = await createTraceProvenance({ tempRoot });
    provenance.ingest(
      JSON.stringify({ stage: 'terminal', request_id: 'req-1', terminal: 'success' }),
    );
    const receipt = await provenance.finish({ failed: false });
    expect(receipt.retained).toBe(false);
    await expect(access(provenance.root)).rejects.toThrow();
  });
});
