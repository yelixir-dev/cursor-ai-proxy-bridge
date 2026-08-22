import { randomUUID } from 'node:crypto';
import { type RequestTrace, traceStage } from '../../trace.js';
import { CursorBackendError, CursorCommandAbortedError } from '../cursor-cli.js';
import type { ChatCompletionRequest } from '../types.js';
import { ConnectFrameDecoder, encodeConnectFrame } from './connect-frame.js';
import type { CursorApiDiscovery } from './discovery.js';
import { sendMcpToolResult } from './exec-responses.js';
import type { CursorHistory } from './history.js';
import { enforceNativeToolChoice, heartbeatMessage, runRequestMessage } from './mapper.js';
import type { RequestedModel } from './requested-models.js';
import { CursorRunTimeoutError, type CursorRunPhase } from './run-errors.js';
import { CursorRunMessages } from './run-messages.js';
import type { RunEmitter, RunOutcome } from './run-types.js';
import { boundedInteger, type CursorApiRuntime } from './runtime.js';
import {
  stickyKey,
  trailingToolResults,
  type HeldRun,
  type ToolResultInput,
} from './sticky-run-store.js';
import { CursorApiHttpError } from './transport.js';

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_OUTPUT_BYTES = 8_388_608;
export const DEFAULT_STICKY_SETTLE_MS = 1_000;

type Dict = Record<string, unknown>;

export interface CursorRunExecutionOptions {
  readonly runtime: CursorApiRuntime;
  readonly discovery: CursorApiDiscovery;
  readonly request: ChatCompletionRequest;
  readonly accessToken: string;
  readonly history: CursorHistory;
  readonly signal?: AbortSignal;
  readonly emit?: RunEmitter;
  readonly trace?: RequestTrace;
  readonly resolveModel?: (model: string, effort?: string) => RequestedModel | undefined;
}

class CursorRunClosedError extends CursorBackendError {
  readonly name = 'CursorRunClosedError';
  readonly code = 'ERR_CURSOR_RUN_NO_TRAILER';
}

function errorValue(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export async function executeCursorRun(options: CursorRunExecutionOptions): Promise<RunOutcome> {
  const { runtime, request, signal, trace } = options;
  if (signal?.aborted) throw new CursorCommandAbortedError();

  const toolResults: ToolResultInput[] = trailingToolResults(request);
  const resumed = toolResults.length > 0 ? runtime.stickyRuns.take(request) : undefined;
  if (resumed) {
    return new Promise<RunOutcome>((resolve, reject) => {
      resumed.resume(resolve, reject, toolResults, options.emit);
    });
  }

  const requestId = randomUUID();
  const stream = await runtime.transport.openRun(
    await options.discovery.agentUrl(options.accessToken, signal),
    requestId,
    options.accessToken,
    trace,
  );
  runtime.activeStreams.add(stream);
  const decoder = new ConnectFrameDecoder();
  const blobs = new Map<string, Buffer>(options.history.blobs);
  const maxOutputBytes = boundedInteger(
    runtime.environment.CURSOR_BRIDGE_MAX_OUTPUT_BYTES,
    DEFAULT_MAX_OUTPUT_BYTES,
  );
  const timeoutMs = boundedInteger(
    runtime.environment.CURSOR_BRIDGE_CURSOR_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
  );
  const settleMs = boundedInteger(
    runtime.environment.CURSOR_BRIDGE_STICKY_SETTLE_MS,
    DEFAULT_STICKY_SETTLE_MS,
  );
  const idleMs = boundedInteger(runtime.environment.CURSOR_BRIDGE_RUN_IDLE_MS, 30_000);

  return new Promise<RunOutcome>((resolve, reject) => {
    let settled = false;
    let parked = false;
    let outputBytes = 0;
    const surfacedCallIds = new Set<string>();
    let surfacedTextLength = 0;
    let phase: CursorRunPhase = 'awaiting_upstream';
    let toolResultsSent = 0;
    let currentResolve: (outcome: RunOutcome) => void = resolve;
    let currentReject: (error: unknown) => void = reject;
    const heldExecs: Array<{ exec: Dict }> = [];
    const parkedPayloads: Buffer[] = [];
    let holdTimer: ReturnType<typeof runtime.timers.setTimeout> | undefined;

    const clearHoldTimer = () => {
      if (holdTimer !== undefined) runtime.timers.clearTimeout(holdTimer);
      holdTimer = undefined;
    };
    const cleanup = () => {
      clearHoldTimer();
      runtime.timers.clearInterval(heartbeat);
      runtime.timers.clearInterval(idleWatchdog);
      runtime.timers.clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      runtime.activeStreams.delete(stream);
    };
    const completedCalls = () =>
      enforceNativeToolChoice(
        messages.toolStream.completedCalls().filter((call) => !surfacedCallIds.has(call.id)),
        request,
      );
    const freshText = () => messages.text.slice(surfacedTextLength);
    const traceToolBatch = () => {
      const counts = messages.toolStream.frameCounts();
      traceStage(trace, 'tool_batch_complete', {
        toolCallsAnnounced: counts.announced,
        toolCallsCompleted: counts.completed,
      });
    };
    const outcome = (): RunOutcome => {
      if (messages.toolStream.batchComplete(request.parallel_tool_calls !== false)) {
        traceToolBatch();
      }
      // Calls surfaced by an earlier hold (sequential tool rounds) must not be
      // re-sent to the client on resume; only the newly completed ones.
      return {
        text: freshText(),
        toolCalls: completedCalls(),
        usage: messages.usageAttribution.usage,
        usageSource: messages.usageAttribution.source,
      };
    };
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!stream.destroyed && !stream.writableEnded) stream.end();
      if (error) {
        currentReject(error);
        return;
      }
      currentResolve(outcome());
    };
    function surfaceBatch(): void {
      const calls = completedCalls();
      if (calls.length === 0) return;
      parked = true;
      phase = 'awaiting_client_tool_results';
      clearHoldTimer();
      for (const call of calls) surfacedCallIds.add(call.id);
      const text = freshText();
      surfacedTextLength = messages.text.length;
      runtime.stickyRuns.park(createHeld(stickyKey(calls.map((call) => call.id))));
      if (messages.toolStream.batchComplete(request.parallel_tool_calls !== false)) {
        traceToolBatch();
      }
      currentResolve({
        text,
        toolCalls: calls,
        usage: messages.usageAttribution.usage,
        usageSource: messages.usageAttribution.source,
      });
    }
    function drain(): void {
      if (completedCalls().length > 0) {
        surfaceBatch();
        return;
      }
      if (turnEnded || streamEnded) finish();
    }
    function hold(): void {
      if (parked || settled || heldExecs.length === 0) return;
      if (messages.toolStream.hasIncompleteStartedCalls()) {
        // A sibling call was announced (start/delta streamed) but its
        // completing mcpArgs has not arrived; parking now would close the
        // OpenAI response with a dangling partial call. Re-arm the settle
        // window; the run timeout and idle watchdog still bound the wait.
        scheduleHold();
        return;
      }
      drain();
    }
    function createHeld(key: string): HeldRun {
      return {
        key,
        resume(nextResolve, nextReject, results, nextEmit) {
          if (settled) return;
          parked = false;
          phase = 'resumed_after_tool_results';
          currentResolve = nextResolve;
          currentReject = nextReject;
          messages.setEmit(nextEmit);
          runtime.activeStreams.add(stream);
          for (const result of results) {
            const targetIndex = heldExecs.findIndex((candidate) => {
              const message = candidate.exec.message as Dict | undefined;
              const value = message?.value as Dict | undefined;
              return String(value?.toolCallId ?? '') === result.id;
            });
            const target = heldExecs[targetIndex];
            if (target) {
              sendMcpToolResult(writeMessage, target.exec, result.content);
              heldExecs.splice(targetIndex, 1);
              toolResultsSent += 1;
            }
          }
          const replay = parkedPayloads.splice(0);
          for (const payload of replay) turnEnded = messages.handle(payload) || turnEnded;
          drain();
        },
        release(error) {
          if (settled) return;
          if (!parked) return;
          // Full teardown: a released hold leaves no stream or timers behind.
          cleanup();
          if (!stream.destroyed) stream.destroy(error ?? new CursorCommandAbortedError());
          currentReject(error ?? new CursorCommandAbortedError());
        },
      };
    }
    const scheduleHold = () => {
      if (parked || settled) return;
      clearHoldTimer();
      // Serialized parallel batches arrive as back-to-back mcpArgs execs;
      // settle briefly so a sibling exec in the same burst joins the same
      // OpenAI tool_calls response instead of a dead held Run.
      holdTimer = runtime.timers.setTimeout(hold, settleMs);
    };
    const onAbort = () => {
      if (parked) {
        runtime.stickyRuns.clear(new CursorCommandAbortedError());
        return;
      }
      const error = new CursorCommandAbortedError();
      if (!stream.destroyed && !stream.writableEnded) stream.end();
      finish(error);
    };
    const writeMessage = (message: Dict, compressed?: boolean) => {
      if (settled || stream.destroyed || stream.writableEnded) return;
      const payload = runtime.codec.encode('agent.v1.AgentClientMessage', message);
      stream.write(encodeConnectFrame(payload, { compressed: compressed ?? payload.length > 512 }));
    };
    const messages = new CursorRunMessages({
      codec: runtime.codec,
      request,
      trace,
      emit: options.emit,
      blobs,
      writeMessage,
      finish,
      onHeld: () => {
        phase = 'settling_tool_calls';
        scheduleHold();
      },
      heldExecs,
      onInteraction: (updateCase) => {
        lastInteractionAt = Date.now();
        lastInteractionCase = updateCase ?? null;
      },
    });

    const heartbeat = runtime.timers.setInterval(() => writeMessage(heartbeatMessage()), 5_000);
    const timeout = runtime.timers.setTimeout(() => {
      const error = new CursorRunTimeoutError(
        parked
          ? `Cursor API run held for a client tool result timed out after ${timeoutMs}ms`
          : `Cursor API run timed out after ${timeoutMs}ms`,
        requestId,
        {
          phase,
          toolResultsSent,
          bufferedFrames: parkedPayloads.length,
          streamState: {
            destroyed: stream.destroyed,
            writableEnded: stream.writableEnded,
          },
          toolCallsAnnounced: messages.toolStream.frameCounts().announced,
          toolCallsCompleted: messages.toolStream.frameCounts().completed,
          lastInteractionCase,
          lastInteractionAgoMs: Math.max(0, Date.now() - lastInteractionAt),
          outputBytes,
          sawTurnEnded: turnEnded,
          sawTrailer: streamEnded,
          transport: stream.diagnostics?.() ?? {},
        },
      );
      stream.destroy(error);
      if (parked) {
        runtime.stickyRuns.clear(error);
        return;
      }
      finish(error);
    }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });

    let turnEnded = false;
    let streamEnded = false;
    let lastInteractionAt = Date.now();
    let lastInteractionCase: string | null = null;
    const idleWatchdog = runtime.timers.setInterval(() => {
      if (settled || parked) return;
      if (Date.now() - lastInteractionAt <= idleMs) return;
      // Silent stall (e.g. the model wants a tool it cannot map to a
      // declared one and emits nothing at all): no interaction frame for the
      // whole window means this turn is dead — fail fast instead of burning
      // the full run timeout.
      const error = new CursorBackendError(
        `Cursor API run produced no model output for ${idleMs}ms`,
      );
      stream.destroy(error);
      finish(error);
    }, 1_000);
    stream.on('response', (headers) => {
      const status = Number(headers[':status']);
      if (status !== 200) {
        finish(new CursorApiHttpError(status, `Cursor Agent Run failed with HTTP ${status}`));
      }
    });
    stream.on('data', (chunk) => {
      if (settled) return;
      if (parked) {
        for (const frame of decoder.push(chunk)) {
          if (frame.payload) parkedPayloads.push(frame.payload);
          if (frame.trailer) parkedPayloads.push(frame.payload ?? Buffer.alloc(0));
        }
        return;
      }
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        const error = new CursorBackendError('output limit exceeded');
        stream.destroy(error);
        finish(error);
        return;
      }
      try {
        for (const frame of decoder.push(chunk)) {
          traceStage(trace, 'first_event');
          if (frame.trailer) streamEnded = true;
          else if (frame.payload) turnEnded = messages.handle(frame.payload) || turnEnded;
        }
        if (settled || parked) return;
        if (streamEnded) finish();
        else if (turnEnded) drain();
      } catch (error) {
        stream.destroy(errorValue(error));
        finish(error);
      }
    });
    stream.once('error', (error) => finish(error));
    stream.once('close', () => {
      if (parked) {
        runtime.stickyRuns.clear(new CursorRunClosedError('held Run stream closed'));
        return;
      }
      if (!settled)
        finish(new CursorRunClosedError('Cursor Agent Run stream closed without a trailer'));
    });
    writeMessage(
      runRequestMessage(
        request,
        requestId,
        options.discovery.requestedModels,
        options.history,
        options.resolveModel?.(request.model, request.reasoning_effort),
      ),
      false,
    );
    if (signal?.aborted) onAbort();
  });
}
