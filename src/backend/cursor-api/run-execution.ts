import { randomUUID } from 'node:crypto';
import { traceCredentialSlot, type RequestTrace, traceStage } from '../../trace.js';
import { CursorBackendError, CursorCommandAbortedError } from '../cursor-cli.js';
import type { ChatCompletionRequest } from '../types.js';
import { ConnectFrameDecoder, ConnectRpcError, encodeConnectFrame } from './connect-frame.js';
import type { CursorApiDiscovery } from './discovery.js';
import { sendMcpToolResult } from './exec-responses.js';
import type { CursorHistory } from './history.js';
import { enforceNativeToolChoice, heartbeatMessage, runRequestMessage } from './mapper.js';
import type { RequestedModel } from './requested-models.js';
import { CursorRunTimeoutError, type CursorRunPhase } from './run-errors.js';
import { CursorRunMessages } from './run-messages.js';
import type { RunEmitter, RunOutcome } from './run-types.js';
import { boundedInteger, type CursorApiRuntime } from './runtime.js';
import { stickyKey, type HeldRun, trailingToolResults } from './sticky-run-store.js';
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
  readonly credentialId: string;
  readonly signal?: AbortSignal;
  readonly emit?: RunEmitter;
  readonly trace?: RequestTrace;
  readonly resolveModel?: (model: string, effort?: string) => RequestedModel | undefined;
}

export interface CursorRunResumeOptions {
  readonly runtime: CursorApiRuntime;
  readonly request: ChatCompletionRequest;
  readonly signal?: AbortSignal;
  readonly emit?: RunEmitter;
  readonly trace?: RequestTrace;
}

class CursorRunClosedError extends CursorBackendError {
  readonly name = 'CursorRunClosedError';
  readonly code = 'ERR_CURSOR_RUN_NO_TRAILER';
}

function errorValue(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function resumeCursorRun(options: CursorRunResumeOptions): Promise<RunOutcome> | undefined {
  const toolResults = trailingToolResults(options.request);
  if (toolResults.length === 0) return undefined;
  const resumed = options.runtime.stickyRuns.take(options.request);
  if (!resumed) return undefined;
  traceCredentialSlot(options.trace, resumed.credentialId);
  return new Promise<RunOutcome>((resolve, reject) => {
    resumed.resume(resolve, reject, toolResults, options.emit, options.signal);
  });
}

export async function executeCursorRun(options: CursorRunExecutionOptions): Promise<RunOutcome> {
  const { runtime, request, signal, trace } = options;
  if (signal?.aborted) throw new CursorCommandAbortedError();

  const resumed = resumeCursorRun(options);
  if (resumed) return resumed;

  const requestId = randomUUID();
  const stream = await runtime.transport.openRun(
    await options.discovery.agentUrl(options.accessToken, signal),
    requestId,
    options.accessToken,
    trace,
  );
  runtime.activeStreams.add(stream);
  const blobs = new Map<string, Buffer>(options.history.blobs);
  const maxOutputBytes = boundedInteger(
    runtime.environment.CURSOR_BRIDGE_MAX_OUTPUT_BYTES,
    DEFAULT_MAX_OUTPUT_BYTES,
  );
  const decoder = new ConnectFrameDecoder(maxOutputBytes);
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
    let activeSignal = signal;
    let outputBytes = 0;
    let decodedOutputBytes = 0;
    const surfacedCallIds = new Set<string>();
    let surfacedTextLength = 0;
    let surfacedOutputEventCount = 0;
    let phase: CursorRunPhase = 'awaiting_upstream';
    let toolResultsSent = 0;
    let currentResolve: (outcome: RunOutcome) => void = resolve;
    let currentReject: (error: unknown) => void = reject;
    const heldExecs: Array<{ exec: Dict }> = [];
    let parkedRun: HeldRun | undefined;
    let holdTimer: ReturnType<typeof runtime.timers.setTimeout> | undefined;
    const timerHandles: {
      heartbeat?: ReturnType<typeof runtime.timers.setInterval>;
      timeout?: ReturnType<typeof runtime.timers.setTimeout>;
      idleWatchdog?: ReturnType<typeof runtime.timers.setInterval>;
    } = {};

    const clearHoldTimer = () => {
      if (holdTimer !== undefined) runtime.timers.clearTimeout(holdTimer);
      holdTimer = undefined;
    };
    const cleanup = () => {
      clearHoldTimer();
      if (timerHandles.heartbeat !== undefined) {
        runtime.timers.clearInterval(timerHandles.heartbeat);
      }
      if (timerHandles.idleWatchdog !== undefined) {
        runtime.timers.clearInterval(timerHandles.idleWatchdog);
      }
      if (timerHandles.timeout !== undefined) {
        runtime.timers.clearTimeout(timerHandles.timeout);
      }
      activeSignal?.removeEventListener('abort', onAbort);
      runtime.activeStreams.delete(stream);
    };
    const closeTransport = () => {
      runtime.activeStreams.delete(stream);
      if (!stream.destroyed) stream.close();
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
      if (settled || parked) return;
      const calls = completedCalls();
      if (calls.length === 0) return;
      clearHoldTimer();
      for (const call of calls) surfacedCallIds.add(call.id);
      const text = freshText();
      surfacedTextLength = messages.text.length;
      surfacedOutputEventCount = messages.outputEvents.length;
      const holdForResults = (!streamEnded && !turnEnded) || completedCalls().length > 0;
      if (holdForResults) {
        parked = true;
        phase = 'awaiting_client_tool_results';
        parkedRun = createHeld(stickyKey(calls.map((call) => call.id)));
        runtime.stickyRuns.park(parkedRun);
      } else {
        settled = true;
        cleanup();
        if (!stream.destroyed && !stream.writableEnded) stream.end();
      }
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
      if (settled || parked) return;
      if ((streamEnded || turnEnded) && messages.toolStream.hasIncompleteStartedCalls()) {
        finish(new CursorBackendError('Cursor API run ended with incomplete tool call'));
        return;
      }
      if (completedCalls().length > 0) {
        surfaceBatch();
        return;
      }
      if (turnEnded || streamEnded) {
        if (freshText().length === 0) {
          finish(new CursorBackendError('Cursor API run ended without content or tool calls'));
          return;
        }
        finish();
      }
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
      const held: HeldRun = {
        key,
        credentialId: options.credentialId,
        resume(nextResolve, nextReject, results, nextEmit, nextSignal) {
          if (settled) return;
          if (parkedRun === held) parkedRun = undefined;
          parked = false;
          phase = 'resumed_after_tool_results';
          currentResolve = nextResolve;
          currentReject = nextReject;
          messages.setEmit(nextEmit);
          bindSignal(nextSignal);
          if (settled) return;
          const bufferedEvents = messages.outputEvents.slice(surfacedOutputEventCount);
          if (bufferedEvents.length > 0 && nextEmit) {
            for (const event of bufferedEvents) nextEmit(event);
            surfacedOutputEventCount = messages.outputEvents.length;
            surfacedTextLength = messages.text.length;
          }
          runtime.activeStreams.add(stream);
          for (const result of results) {
            const execId = messages.toolStream.execIdFor(result.id) ?? result.id;
            const targetIndex = heldExecs.findIndex((candidate) => {
              const message = candidate.exec.message as Dict | undefined;
              const value = message?.value as Dict | undefined;
              return String(value?.toolCallId ?? '') === execId;
            });
            const target = heldExecs[targetIndex];
            if (target) {
              if (!streamEnded && !turnEnded) {
                sendMcpToolResult(writeMessage, target.exec, result.content);
                toolResultsSent += 1;
              }
              heldExecs.splice(targetIndex, 1);
            }
          }
          drain();
        },
        release(error) {
          if (settled) return;
          if (!parked) return;
          parked = false;
          // Full teardown: a released hold leaves no stream or timers behind.
          cleanup();
          if (!stream.destroyed) stream.destroy(error ?? new CursorCommandAbortedError());
          currentReject(error ?? new CursorCommandAbortedError());
        },
      };
      return held;
    }
    function releaseParked(error: Error): void {
      const held = parkedRun;
      parkedRun = undefined;
      if (held && runtime.stickyRuns.release(held, error)) return;
      cleanup();
      if (!stream.destroyed) stream.destroy(error);
      currentReject(error);
    }
    const scheduleHold = () => {
      if (parked || settled) return;
      clearHoldTimer();
      // Serialized parallel batches arrive as back-to-back mcpArgs execs;
      // settle briefly so a sibling exec in the same burst joins the same
      // OpenAI tool_calls response instead of a dead held Run.
      holdTimer = runtime.timers.setTimeout(hold, settleMs);
    };
    function onAbort(): void {
      if (parked) {
        releaseParked(new CursorCommandAbortedError());
        return;
      }
      const error = new CursorCommandAbortedError();
      if (!stream.destroyed && !stream.writableEnded) stream.end();
      finish(error);
    }
    function bindSignal(nextSignal: AbortSignal | undefined): void {
      activeSignal?.removeEventListener('abort', onAbort);
      activeSignal = nextSignal;
      if (activeSignal?.aborted) {
        onAbort();
        return;
      }
      activeSignal?.addEventListener('abort', onAbort, { once: true });
    }
    const writeMessage = (message: Dict, compressed?: boolean) => {
      if (settled || stream.destroyed || stream.writableEnded) return;
      const payload = runtime.codec.encode('agent.v1.AgentClientMessage', message);
      stream.write(encodeConnectFrame(payload, { compressed: compressed ?? payload.length > 512 }));
    };
    const messages = new CursorRunMessages({
      codec: runtime.codec,
      request,
      callIdPrefix: requestId,
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
        if (heldExecs.length > 0 && !parked && !settled) scheduleHold();
      },
    });

    timerHandles.heartbeat = runtime.timers.setInterval(
      () => writeMessage(heartbeatMessage()),
      5_000,
    );
    timerHandles.timeout = runtime.timers.setTimeout(() => {
      const error = new CursorRunTimeoutError(
        parked
          ? `Cursor API run held for a client tool result timed out after ${timeoutMs}ms`
          : `Cursor API run timed out after ${timeoutMs}ms`,
        requestId,
        {
          phase,
          toolResultsSent,
          bufferedFrames: 0,
          streamState: {
            destroyed: stream.destroyed,
            writableEnded: stream.writableEnded,
          },
          toolCallsAnnounced: messages.toolStream.frameCounts().announced,
          toolCallsCompleted: messages.toolStream.frameCounts().completed,
          lastInteractionCase,
          lastInteractionAgoMs: Math.max(0, Date.now() - lastInteractionAt),
          outputBytes,
          decodedOutputBytes,
          sawTurnEnded: turnEnded,
          sawTrailer: streamEnded,
          transport: stream.diagnostics?.() ?? {},
        },
      );
      stream.destroy(error);
      if (parked) {
        releaseParked(error);
        return;
      }
      finish(error);
    }, timeoutMs);
    bindSignal(activeSignal);
    if (settled) return;

    let turnEnded = false;
    let streamEnded = false;
    let lastInteractionAt = Date.now();
    let lastInteractionCase: string | null = null;
    timerHandles.idleWatchdog = runtime.timers.setInterval(() => {
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
      try {
        const frames = decoder.push(chunk);
        outputBytes = decoder.rawOutputBytes;
        if (outputBytes > maxOutputBytes) {
          throw new CursorBackendError('output limit exceeded');
        }
        const decodedBytes = frames.reduce(
          (total, frame) =>
            total +
            (frame.payload?.length ??
              (frame.trailer ? Buffer.byteLength(JSON.stringify(frame.trailer)) : 0)),
          0,
        );
        if (decodedOutputBytes + decodedBytes > maxOutputBytes) {
          throw new CursorBackendError('output limit exceeded');
        }
        decodedOutputBytes += decodedBytes;
        if (parked) {
          messages.setEmit(undefined);
          for (const frame of frames) {
            if (settled) break;
            if (frame.trailer) {
              streamEnded = true;
              if (frame.error) {
                if (completedCalls().length === 0) {
                  releaseParked(frame.error);
                } else {
                  closeTransport();
                }
                return;
              }
            } else if (frame.payload) {
              try {
                turnEnded = messages.handle(frame.payload) || turnEnded;
              } catch (error) {
                if (completedCalls().length === 0) throw error;
                streamEnded = true;
                closeTransport();
                return;
              }
            }
          }
          if (settled) {
            const held = parkedRun;
            parkedRun = undefined;
            if (held) runtime.stickyRuns.release(held);
          } else if ((streamEnded || turnEnded) && completedCalls().length === 0) {
            releaseParked(new CursorRunClosedError('held Run ended before client tool result'));
          }
          if (streamEnded) closeTransport();
          return;
        }
        for (const frame of frames) {
          traceStage(trace, 'first_event');
          if (frame.trailer) {
            streamEnded = true;
            if (frame.error) throw frame.error;
          } else if (frame.payload) turnEnded = messages.handle(frame.payload) || turnEnded;
        }
        if (settled || parked) {
          if (streamEnded) closeTransport();
          return;
        }
        if (streamEnded || turnEnded) drain();
        if (streamEnded) closeTransport();
      } catch (error) {
        outputBytes = decoder.rawOutputBytes;
        const caught = errorValue(error);
        if (
          parked &&
          caught instanceof ConnectRpcError &&
          caught.terminal &&
          completedCalls().length > 0
        ) {
          streamEnded = true;
          closeTransport();
        } else if (parked) releaseParked(caught);
        else {
          stream.destroy(caught);
          finish(caught);
        }
      }
    });
    stream.once('error', (error) => {
      if (parked) {
        if (completedCalls().length > 0) {
          streamEnded = true;
          runtime.activeStreams.delete(stream);
          return;
        }
        releaseParked(error);
        return;
      }
      finish(error);
    });
    stream.once('close', () => {
      if (parked) {
        if (completedCalls().length > 0) {
          streamEnded = true;
          runtime.activeStreams.delete(stream);
          return;
        }
        releaseParked(new CursorRunClosedError('held Run stream closed'));
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
    if (activeSignal?.aborted) onAbort();
  });
}
