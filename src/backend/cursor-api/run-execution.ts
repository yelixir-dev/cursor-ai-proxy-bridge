import { randomUUID } from 'node:crypto';
import { type RequestTrace, traceStage } from '../../trace.js';
import { CursorBackendError, CursorCommandAbortedError } from '../cursor-cli.js';
import type { ChatCompletionRequest } from '../types.js';
import { ConnectFrameDecoder, encodeConnectFrame } from './connect-frame.js';
import type { CursorApiDiscovery } from './discovery.js';
import type { CursorHistory } from './history.js';
import { enforceNativeToolChoice, heartbeatMessage, runRequestMessage } from './mapper.js';
import { CursorRunMessages } from './run-messages.js';
import type { RunEmitter, RunOutcome } from './run-types.js';
import { boundedInteger, type CursorApiRuntime } from './runtime.js';
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

  return new Promise<RunOutcome>((resolve, reject) => {
    let settled = false;
    let outputBytes = 0;
    const cleanup = () => {
      runtime.timers.clearInterval(heartbeat);
      runtime.timers.clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      runtime.activeStreams.delete(stream);
    };
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!stream.destroyed && !stream.writableEnded) stream.end();
      if (error) {
        reject(error);
        return;
      }
      if (messages.toolStream.batchComplete(request.parallel_tool_calls !== false)) {
        traceStage(trace, 'tool_batch_complete');
      }
      resolve({
        text: messages.text,
        toolCalls: enforceNativeToolChoice(messages.toolStream.completedCalls(), request),
        usage: messages.usageAttribution.usage,
        usageSource: messages.usageAttribution.source,
      });
    };
    const onAbort = () => {
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
    });

    const heartbeat = runtime.timers.setInterval(() => writeMessage(heartbeatMessage()), 5_000);
    const timeout = runtime.timers.setTimeout(() => {
      const error = new CursorBackendError(`Cursor API run timed out after ${timeoutMs}ms`);
      stream.destroy(error);
      finish(error);
    }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    stream.on('response', (headers) => {
      const status = Number(headers[':status']);
      if (status !== 200) {
        finish(new CursorApiHttpError(status, `Cursor Agent Run failed with HTTP ${status}`));
      }
    });
    stream.on('data', (chunk) => {
      if (settled) return;
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        const error = new CursorBackendError('output limit exceeded');
        stream.destroy(error);
        finish(error);
        return;
      }
      try {
        // The whole decoded frame batch is applied before any boundary check,
        // so a call announced in the same chunk as the boundary is retained.
        let turnEnded = false;
        let streamEnded = false;
        for (const frame of decoder.push(chunk)) {
          traceStage(trace, 'first_event');
          if (frame.trailer) streamEnded = true;
          else if (frame.payload) turnEnded = messages.handle(frame.payload) || turnEnded;
        }
        if (settled) return;
        if (turnEnded || streamEnded) finish();
      } catch (error) {
        stream.destroy(errorValue(error));
        finish(error);
      }
    });
    stream.once('error', (error) => finish(error));
    stream.once('close', () => {
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
