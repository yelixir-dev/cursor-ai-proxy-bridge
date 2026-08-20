import { describe, expect, it, vi } from 'vitest';
import { AutoCursorBackend, type ProbeableCursorApiBackend } from '../src/backend/auto.js';
import { createCursorCliBackend } from '../src/backend/cursor-cli.js';
import type {
  BackendHealth,
  ChatCompletionRequest,
  CompletionResult,
  CompletionStreamEvent,
  CursorBackend,
} from '../src/backend/types.js';
import { BridgeTraceCollector, parseTraceRecord } from '../src/benchmark/bridge-trace.js';
import {
  createRequestTrace,
  finishTrace,
  traceBackend,
  traceRetry,
  traceUsageSource,
  type TraceRecord,
} from '../src/trace.js';
import type { BridgeConfig } from '../src/config.js';

const request: ChatCompletionRequest = {
  model: 'composer-2.5',
  messages: [{ role: 'user', content: 'attribute lifecycle' }],
};
const config: BridgeConfig = {
  host: '127.0.0.1',
  port: 0,
  backend: 'cursor-cli',
  defaultModel: 'composer-2.5',
  workspaceMode: 'chat-only',
  version: 'test',
};

function staticBackend(type: string, complete: () => Promise<CompletionResult>): CursorBackend {
  return {
    type,
    health: async (): Promise<BackendHealth> => ({ ok: true, type, authConfigured: true }),
    listModels: async () => [],
    complete,
    completeStream: async function* (): AsyncIterable<CompletionStreamEvent> {
      yield {
        type: 'done',
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        usage_source: 'unknown',
        is_error: false,
      };
    },
  };
}

describe('task 11 usage and trace attribution', () => {
  it('records retry count, typed reason, usage source, final backend, and quiescence', () => {
    const records: TraceRecord[] = [];
    const trace = createRequestTrace({
      environment: { CURSOR_BRIDGE_TRACE: '1' },
      requestId: 'task-11-attribution',
      model: request.model,
      sink: (record) => records.push(record),
    });
    traceBackend(trace, 'cursor-api');
    traceRetry(trace, 'transport');
    traceUsageSource(trace, 'turnEnded');
    finishTrace(trace, 'success', { quiescent: true });

    expect(records.at(-1)).toMatchObject({
      upstream_run_count: 0,
      retry_count: 1,
      retry_kind: 'transport',
      usage_source: 'turnEnded',
      final_backend_state: 'cursor-api',
      cancelled: false,
      quiescent: true,
    });
  });

  it('rejects malformed retry trace records with omitted typed reason', () => {
    expect(
      parseTraceRecord(
        {
          request_id: 'req-task-11',
          credential_slot_id: null,
          backend: 'cursor-api',
          model: 'composer-2.5',
          upstream_run_count: 2,
          retry_count: 1,
          stage: 'retry',
          offset_ms: 1,
        },
        1,
      ),
    ).toBeNull();
  });

  it('classifies CLI-reported and estimated usage without changing OpenAI token values', async () => {
    const reported = createCursorCliBackend(config, {
      commandRunner: async () =>
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          result: 'reported',
          usage: { inputTokens: 7, outputTokens: 3 },
        }),
    });
    const estimated = createCursorCliBackend(config, {
      commandRunner: async () => 'plain fallback',
    });

    await expect(reported.complete(request)).resolves.toMatchObject({
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
      usage_source: 'cli_reported',
    });
    await expect(estimated.complete(request)).resolves.toMatchObject({
      usage_source: 'estimated',
    });
  });

  it('aborts benchmark work immediately when a scoped backend flip is observed', () => {
    const collector = new BridgeTraceCollector();
    const scope = collector.beginScope();
    const abort = vi.fn();
    const unsubscribe = scope.subscribeBackendChange(abort);

    collector.ingestValue({
      request_id: 'req-task-11',
      credential_slot_id: null,
      backend: 'cursor-api',
      model: 'composer-2.5',
      upstream_run_count: 0,
      retry_count: 0,
      stage: 'backend',
      offset_ms: 0,
    });
    collector.ingestValue({
      request_id: 'req-task-11',
      credential_slot_id: null,
      backend: 'cursor-cli',
      model: 'composer-2.5',
      upstream_run_count: 0,
      retry_count: 0,
      stage: 'backend_flip',
      offset_ms: 1,
    });
    collector.ingestValue({
      request_id: 'req-task-11',
      credential_slot_id: null,
      backend: 'cursor-cli',
      model: 'composer-2.5',
      upstream_run_count: 0,
      retry_count: 0,
      stage: 'backend_flip',
      offset_ms: 2,
    });
    unsubscribe();

    expect(abort).toHaveBeenCalledTimes(1);
    expect(scope.snapshot().flips).toBe(2);
  });
});

describe('task 11 auto backend request isolation', () => {
  it('never replays a fatal cursor-api request on CLI and flips only the next request', async () => {
    const failure = new Error('client is out of date');
    const api = staticBackend('cursor-api', async () =>
      Promise.reject(failure),
    ) as ProbeableCursorApiBackend;
    api.initialize = async () => undefined;
    api.probe = async () => undefined;
    const cliComplete = vi.fn(async () => ({ content: 'cli', model: request.model }));
    const automatic = new AutoCursorBackend(api, staticBackend('cursor-cli', cliComplete), {
      now: () => 1,
      warn: vi.fn(),
      cooldownMs: 100,
      fatalThreshold: 3,
      probeTimeoutMs: 10,
      initial: 'cursor-api',
    });

    await expect(automatic.complete(request)).rejects.toBe(failure);
    expect(cliComplete).not.toHaveBeenCalled();
    await expect(automatic.complete(request)).resolves.toMatchObject({ content: 'cli' });
    expect(cliComplete).toHaveBeenCalledTimes(1);
  });
});
