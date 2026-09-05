import { describe, expect, it } from 'vitest';
import { frontmatter, NativeSourceReader } from '../src/backend/cursor-api/native-context-files.js';

describe('native context bounded source reads', () => {
  it('does not fail a queued read when an unrelated active read fails', async () => {
    const active = Array.from({ length: 4 }, () => Promise.withResolvers<Response>());
    const started = Promise.withResolvers<void>();
    let calls = 0;
    const reader = new NativeSourceReader({
      signal: AbortSignal.timeout(5_000),
      fetch: async () => {
        const index = calls++;
        if (index === 3) started.resolve();
        const response = active[index];
        return response ? response.promise : new Response('QUEUED_OK');
      },
    });
    const results = Promise.allSettled(
      Array.from({ length: 5 }, (_, index) => reader.read('https://example.test/' + index)),
    );
    await started.promise;
    expect(calls).toBe(4);
    const failure = new Error('unrelated fetch failed');
    active[0]?.reject(failure);
    for (const response of active.slice(1)) response.resolve(new Response('ACTIVE_OK'));
    const settled = await results;
    expect(settled[0]).toEqual({ status: 'rejected', reason: failure });
    expect(settled[4]).toEqual({ status: 'fulfilled', value: 'QUEUED_OK' });
    expect(calls).toBe(5);
  });

  it('bounds total cached bytes and source attempts independently', async () => {
    const reader = new NativeSourceReader({
      signal: AbortSignal.timeout(5_000),
      fetch: async () => new Response('ABC'),
      maxTotalSourceBytes: 5,
    });
    expect(await reader.read('https://example.test/one')).toBe('ABC');
    await expect(reader.read('https://example.test/two')).rejects.toThrow(/total byte limit/);
    const countReader = new NativeSourceReader({
      signal: AbortSignal.timeout(5_000),
      fetch: async () => new Response('ABC'),
      maxSourceFiles: 1,
    });
    expect(await countReader.read('https://example.test/one')).toBe('ABC');
    expect(await countReader.read('https://example.test/one')).toBe('ABC');
    await expect(countReader.read('https://example.test/two')).rejects.toThrow(/file limit/);
  });

  it('cancels a queued read without consuming a fetch slot or cancelling active callers', async () => {
    const active = Array.from({ length: 4 }, () => Promise.withResolvers<Response>());
    const started = Promise.withResolvers<void>();
    let calls = 0;
    const reader = new NativeSourceReader({
      signal: AbortSignal.timeout(5_000),
      fetch: async () => {
        const response = active[calls++];
        if (calls === 4) started.resolve();
        if (!response) throw new Error('Cancelled queued read must not fetch');
        return response.promise;
      },
    });
    const running = Promise.all(
      Array.from({ length: 4 }, (_, index) => reader.read('https://example.test/' + index)),
    );
    await started.promise;
    const controller = new AbortController();
    const cancelled = expect(
      reader.read('https://example.test/queued', controller.signal),
    ).rejects.toThrow('queued-abort');
    controller.abort(new Error('queued-abort'));
    await cancelled;
    expect(calls).toBe(4);
    for (const response of active) response.resolve(new Response('ACTIVE_OK'));
    expect(await running).toEqual(['ACTIVE_OK', 'ACTIVE_OK', 'ACTIVE_OK', 'ACTIVE_OK']);
    expect(calls).toBe(4);
  });

  it('cancels an oversized streaming body without trusting content-length', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(9));
      },
      cancel() {
        cancelled = true;
      },
    });
    const reader = new NativeSourceReader({
      signal: AbortSignal.timeout(5_000),
      fetch: async () => new Response(body),
      maxSourceBytes: 8,
    });
    await expect(reader.read('https://example.test/body')).rejects.toThrow(/byte limit/);
    expect(cancelled).toBe(true);
  });

  it('aborts while awaiting a body chunk using an exact subscription', async () => {
    const started = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          started.resolve();
        },
        cancel() {
          cancelled.resolve();
        },
      },
      { highWaterMark: 0 },
    );
    const controller = new AbortController();
    const reader = new NativeSourceReader({
      signal: AbortSignal.timeout(5_000),
      fetch: async () => new Response(body),
    });
    const assertion = expect(
      reader.read('https://example.test/pending', controller.signal),
    ).rejects.toThrow('body-abort');
    await started.promise;
    controller.abort(new Error('body-abort'));
    await assertion;
    await cancelled.promise;
  });

  it('limits active HTTP reads to four, including queued lazy reads', async () => {
    const started = Array.from({ length: 9 }, () => Promise.withResolvers<void>());
    const replies = Array.from({ length: 9 }, () => Promise.withResolvers<Response>());
    let calls = 0;
    const reader = new NativeSourceReader({
      signal: AbortSignal.timeout(5_000),
      fetch: async () => {
        const index = calls++;
        started[index]?.resolve();
        const reply = replies[index];
        if (!reply) throw new Error('Unexpected fetch');
        return reply.promise;
      },
    });
    const result = Promise.all(
      Array.from({ length: 9 }, (_, index) => reader.read('https://example.test/' + index)),
    );
    await started[3]?.promise;
    expect(calls).toBe(4);
    for (const reply of replies.slice(0, 4)) reply.resolve(new Response('FOUR'));
    await started[7]?.promise;
    expect(calls).toBe(8);
    for (const reply of replies.slice(4)) reply.resolve(new Response('REST'));
    expect(await result).toHaveLength(9);
    expect(calls).toBe(9);
  });

  it('rejects YAML tags/aliases and never leaks source text in errors', () => {
    for (const text of [
      '---\na: &one SECRET_SENTINEL\nb: *one\n---\nbody',
      '---\na: !custom SECRET_SENTINEL\n---\nbody',
    ]) {
      expect(() => frontmatter(text)).toThrow(/frontmatter/);
      try {
        frontmatter(text);
      } catch (error) {
        expect(String(error)).not.toContain('SECRET_SENTINEL');
      }
    }
  });
});
