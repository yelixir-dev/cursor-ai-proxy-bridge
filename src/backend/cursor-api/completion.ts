import { requestTrace, traceBackend, traceRetry, traceUpstreamError } from '../../trace.js';
import { TOOL_CALL_MARKER, ToolTextStreamFilter } from '../tool-call-stream.js';
import type { ChatCompletionRequest, CompletionResult, CompletionStreamEvent } from '../types.js';
import { AsyncQueue } from './async-queue.js';
import { withCursorCredential } from './credential-route.js';
import type { CursorApiDiscovery } from './discovery.js';
import { buildCursorHistory } from './history.js';
import { cursorProviderErrorDiagnostics } from './provider-error.js';
import { cursorRetryFailureKind } from './retry.js';
import { CursorRunTimeoutError } from './run-errors.js';
import { executeCursorRun, resumeCursorRun } from './run-execution.js';
import type { RunEmitter, RunLifecycle, RunOutcome } from './run-types.js';
import { boundedInteger, type CursorApiRuntime } from './runtime.js';
import { choiceRequiresTool, runValidatedCursorCompletion } from './validated-run.js';
import { createSemanticOutputGate } from './visible-lifecycle.js';

const DEFAULT_RETRY_BASE_MS = 1_000;
const MAX_RETRY_DELAY_MS = 60_000;
const MAX_SERVER_RETRIES = 3;
const MAX_TRANSPORT_RETRIES = 1;

export class CursorApiCompletion {
  constructor(
    private readonly runtime: CursorApiRuntime,
    private readonly discovery: CursorApiDiscovery,
  ) {}

  async complete(request: ChatCompletionRequest, signal?: AbortSignal): Promise<CompletionResult> {
    const trace = requestTrace(request);
    traceBackend(trace, 'cursor-api');
    const outcome = await runValidatedCursorCompletion({
      request,
      lifecycle: { signal, trace },
      run: (candidate, lifecycle) => this.run(candidate, lifecycle),
      onToolValidationFailure: (calls, error) =>
        this.runtime.stickyRuns.releaseToolCalls(
          calls.map((call) => call.id),
          error,
        ),
    });
    return outcome.toolCalls.length
      ? {
          content: null,
          model: request.model,
          tool_calls: outcome.toolCalls,
          usage: outcome.usage,
          usage_source: outcome.usageSource,
        }
      : {
          content: outcome.text || null,
          model: request.model,
          usage: outcome.usage,
          usage_source: outcome.usageSource,
        };
  }

  async *completeStream(
    request: ChatCompletionRequest,
    signal?: AbortSignal,
  ): AsyncIterable<CompletionStreamEvent> {
    const trace = requestTrace(request);
    traceBackend(trace, 'cursor-api');
    const validated = (lifecycle: RunLifecycle) =>
      runValidatedCursorCompletion({
        request,
        lifecycle,
        run: (candidate, nestedLifecycle) => this.run(candidate, nestedLifecycle),
        onToolValidationFailure: (calls, error) =>
          this.runtime.stickyRuns.releaseToolCalls(
            calls.map((call) => call.id),
            error,
          ),
      });
    if (request.tools?.length && choiceRequiresTool(request)) {
      const outcome = await validated({ signal, trace });
      if (outcome.toolCalls.length) {
        yield { type: 'content', text: `[TOOL_CALLS: ${JSON.stringify(outcome.toolCalls)}]` };
      } else if (outcome.text) yield { type: 'content', text: outcome.text };
      yield {
        type: 'done',
        usage: outcome.usage,
        usage_source: outcome.usageSource,
        is_error: false,
      };
      return;
    }

    const queue = new AsyncQueue<CompletionStreamEvent>();
    const filter = request.tools?.length
      ? new ToolTextStreamFilter(request.tool_choice !== 'none')
      : undefined;
    let streamedContent = false;
    let streamedToolCall = false;
    const emit: RunEmitter = (event) => {
      switch (event.type) {
        case 'thinking':
        case 'done':
          queue.push(event);
          return false;
        case 'content': {
          if (!filter) {
            queue.push(event);
            return true;
          }
          const safe = filter.push(event.text);
          if (!safe) return false;
          streamedContent = true;
          queue.push({ type: 'content', text: safe });
          return true;
        }
        case 'tool_call_start':
        case 'tool_call_arguments_delta':
        case 'tool_call_complete':
          streamedToolCall = true;
          queue.push(event);
          return true;
        default: {
          const exhaustive: never = event;
          return exhaustive;
        }
      }
    };
    emit.reset = () => filter?.reset();
    const execution = (
      filter ? validated({ signal, emit, trace }) : this.run(request, { signal, emit, trace })
    )
      .then((outcome) => {
        const trailing = filter?.finish() ?? '';
        if (trailing) {
          streamedContent = true;
          queue.push({ type: 'content', text: trailing });
        }
        if (outcome.toolCalls.length && !streamedToolCall) {
          queue.push({
            type: 'content',
            text: `${TOOL_CALL_MARKER} ${JSON.stringify(outcome.toolCalls)}]`,
          });
        } else if (
          filter &&
          outcome.text &&
          !streamedContent &&
          !filter.suppressedToolPayload &&
          !outcome.text.includes(TOOL_CALL_MARKER)
        ) {
          queue.push({ type: 'content', text: outcome.text });
        }
        queue.push({
          type: 'done',
          usage: outcome.usage,
          usage_source: outcome.usageSource,
          is_error: false,
        });
        queue.end();
      })
      .catch((error: unknown) => queue.fail(error));
    try {
      for await (const event of queue) yield event;
    } finally {
      await execution;
    }
  }

  private async run(request: ChatCompletionRequest, lifecycle: RunLifecycle): Promise<RunOutcome> {
    const history = buildCursorHistory(request, this.runtime.codec);
    const gate = lifecycle.gate ?? createSemanticOutputGate();
    const trackedEmit: RunEmitter | undefined = lifecycle.emit
      ? Object.assign(
          (event: CompletionStreamEvent) => {
            const delivered = lifecycle.emit?.(event);
            gate.record(event, delivered);
            return delivered;
          },
          { reset: lifecycle.emit.reset },
        )
      : undefined;
    let serverRetries = 0;
    let transportRetries = 0;
    const retryBaseMs = boundedInteger(
      this.runtime.environment.CURSOR_BRIDGE_CURSOR_RETRY_BASE_MS,
      DEFAULT_RETRY_BASE_MS,
    );
    const retryRunTimeout =
      this.runtime.environment.CURSOR_BRIDGE_RETRY_RUN_TIMEOUT?.trim() === '1';
    const retryProvider5xx =
      this.runtime.environment.CURSOR_BRIDGE_RETRY_PROVIDER_5XX?.trim() === '1';
    let preferredCredentialId: string | undefined;
    for (;;) {
      try {
        const resumed = resumeCursorRun({
          runtime: this.runtime,
          request,
          signal: lifecycle.signal,
          emit: trackedEmit,
          trace: lifecycle.trace,
          onCredential: (credentialId) => {
            preferredCredentialId = credentialId;
          },
        });
        if (resumed) return await resumed;
        return await withCursorCredential(this.runtime, {
          operation: async (credential, accessToken) => {
            preferredCredentialId = credential.id;
            return executeCursorRun({
              runtime: this.runtime,
              discovery: this.discovery,
              request,
              accessToken,
              history,
              credentialId: credential.id,
              signal: lifecycle.signal,
              emit: trackedEmit,
              trace: lifecycle.trace,
              resolveModel: (model, effort) => this.discovery.resolveRequestedModel(model, effort),
            });
          },
          signal: lifecycle.signal,
          trace: lifecycle.trace,
          canFailover: () => !gate.delivered,
          ...(preferredCredentialId === undefined ? {} : { preferredCredentialId }),
        });
      } catch (error) {
        traceUpstreamError(lifecycle.trace, cursorProviderErrorDiagnostics(error));
        const kind =
          retryRunTimeout && error instanceof CursorRunTimeoutError
            ? 'transport'
            : cursorRetryFailureKind(error, { retryProvider5xx });
        if (!kind || gate.delivered || lifecycle.signal?.aborted) throw error;
        const retries = kind === 'server' ? serverRetries : transportRetries;
        const limit = kind === 'server' ? MAX_SERVER_RETRIES : MAX_TRANSPORT_RETRIES;
        if (retries >= limit) throw error;
        if (kind === 'server') serverRetries += 1;
        else transportRetries += 1;
        trackedEmit?.reset?.();
        const nextRetry = kind === 'server' ? serverRetries : transportRetries;
        traceRetry(lifecycle.trace, kind);
        await this.runtime.wait(
          Math.min(retryBaseMs * 2 ** nextRetry, MAX_RETRY_DELAY_MS),
          lifecycle.signal,
        );
      }
    }
  }
}
