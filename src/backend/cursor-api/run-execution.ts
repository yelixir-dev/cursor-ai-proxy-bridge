import { randomUUID } from 'node:crypto';
import { type RequestTrace, traceStage } from '../../trace.js';
import { CursorBackendError, CursorCommandAbortedError } from '../cursor-cli.js';
import type { ChatCompletionRequest } from '../types.js';
import { ConnectFrameDecoder, encodeConnectFrame } from './connect-frame.js';
import type { CursorApiDiscovery } from './discovery.js';
import { sendMcpToolResult } from './exec-responses.js';
import type { CursorHistory } from './history.js';
import { enforceNativeToolChoice, heartbeatMessage, runRequestMessage } from './mapper.js';
import { CursorRunMessages } from './run-messages.js';
import type { RunEmitter, RunOutcome } from './run-types.js';
import { boundedInteger, type CursorApiRuntime } from './runtime.js';
import { heldExecToKey, type HeldRun, type ToolResultInput } from './sticky-run-store.js';
import { CursorApiHttpError } from './transport.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 8_388_608;

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

  const toolResults: ToolResultInput[] = request.messages.flatMap((message) =>
    message.role === 'tool' && typeof message.tool_call_id === 'string'
      ? [{ id: message.tool_call_id, content: message.content ?? '' }]
      : [],
  );
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
  const settleMs = boundedInteger(runtime.environment.CURSOR_BRIDGE_STICKY_SETTLE_MS, 250);

  return new Promise<RunOutcome>((resolve, reject) => {
    let settled = false;
    let parked = false;
    let outputBytes = 0;
    let surfacedCount = 0;
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
      runtime.timers.clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      runtime.activeStreams.delete(stream);
    };
    const completedCalls = () =>
      enforceNativeToolChoice(messages.toolStream.completedCalls(), request);
    const outcome = (): RunOutcome => {
      if (messages.toolStream.batchComplete(request.parallel_tool_calls !== false)) {
        traceStage(trace, 'tool_batch_complete');
      }
      // Calls surfaced by an earlier hold (sequential tool rounds) must not be
      // re-sent to the client on resume; only the newly completed ones.
      return {
        text: messages.text,
        toolCalls: completedCalls().slice(surfacedCount),
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
    const hold = () => {
      if (parked || settled || heldExecs.length === 0) return;
      parked = true;
      clearHoldTimer();
      const held: HeldRun = {
        key: heldExecToKey(heldExecs),
        resume(nextResolve, nextReject, results, nextEmit) {
          if (settled) return;
          parked = false;
          currentResolve = nextResolve;
          currentReject = nextReject;
          messages.setEmit(nextEmit);
          runtime.activeStreams.add(stream);
          for (const result of results) {
            const target = heldExecs.find((held) => {
              const message = held.exec.message as Dict | undefined;
              const value = message?.value as Dict | undefined;
              return String(value?.toolCallId ?? '') === result.id;
            });
            if (target) sendMcpToolResult(writeMessage, target.exec, result.content);
          }
          heldExecs.length = 0;
          const replay = parkedPayloads.splice(0);
          for (const payload of replay) turnEnded = messages.handle(payload) || turnEnded;
          if (turnEnded || streamEnded) finish();
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
      runtime.stickyRuns.park(held);
      const all = completedCalls();
      const fresh = all.slice(surfacedCount);
      surfacedCount = all.length;
      currentResolve({
        text: messages.text,
        toolCalls: fresh,
        usage: messages.usageAttribution.usage,
        usageSource: messages.usageAttribution.source,
      });
    };
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
      onHeld: scheduleHold,
      heldExecs,
    });

    const heartbeat = runtime.timers.setInterval(() => writeMessage(heartbeatMessage()), 5_000);
    const timeout = runtime.timers.setTimeout(() => {
      const error = new CursorBackendError(
        parked
          ? `Cursor API run held for a client tool result timed out after ${timeoutMs}ms`
          : `Cursor API run timed out after ${timeoutMs}ms`,
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
        if (turnEnded || streamEnded) finish();
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
      runRequestMessage(request, requestId, options.discovery.requestedModels, options.history),
      false,
    );
    if (signal?.aborted) onAbort();
  });
}
