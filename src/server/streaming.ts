import { once } from 'node:events';
import type { FastifyReply } from 'fastify';
import type {
  ChatCompletionRequest,
  CompletionStreamEvent,
  CompletionUsage,
  CursorBackend,
  ToolCall,
} from '../backend/types.js';
import { filterToolCallsToAllowed, parseToolCallsFromText } from '../backend/tool-call-parse.js';
import { TOOL_CALL_MARKER, ToolTextStreamFilter } from '../backend/tool-call-stream.js';
import { CursorBackendError } from '../backend/cursor-cli.js';
import { OpenAiToolStreamAccumulator, type OpenAiToolCallDelta } from '../openai-tool-stream.js';
import { traceUsageSource, type RequestTrace } from '../trace.js';
import { backendErrorMessage, completionChunk, openAiError, sseData } from './responses.js';

export type StreamCompletionResult = {
  readonly reply: FastifyReply;
  readonly terminal: 'success' | 'error' | 'abort';
};

type StreamRequest = {
  readonly backend: CursorBackend;
  readonly request: ChatCompletionRequest;
  readonly reply: FastifyReply;
  readonly signal: AbortSignal;
  readonly id: string;
  readonly created: number;
  readonly trace?: RequestTrace;
};

function splitSseContent(content: string): readonly string[] {
  const chunks = content.match(/\S+\s*/g);
  return chunks && chunks.length > 0 ? chunks : [];
}

function streamedToolCalls(request: ChatCompletionRequest, text: string): ToolCall[] {
  if (request.tool_choice === 'none') return [];
  let calls = filterToolCallsToAllowed(parseToolCallsFromText(text), request.tools);
  const forcedName =
    typeof request.tool_choice === 'object' ? request.tool_choice.function.name : undefined;
  if (forcedName) calls = calls.filter((call) => call.function.name === forcedName);
  return request.parallel_tool_calls === false ? calls.slice(0, 1) : calls;
}

async function writeSse(reply: FastifyReply, frame: string): Promise<void> {
  if (reply.raw.destroyed || reply.raw.writableEnded) return;
  if (reply.raw.write(frame)) return;
  await Promise.race([once(reply.raw, 'drain'), once(reply.raw, 'close')]);
}

export async function streamChatCompletion(input: StreamRequest): Promise<StreamCompletionResult> {
  const { backend, request, reply, signal, id, created, trace } = input;
  const iterator = backend.completeStream(request, signal)[Symbol.asyncIterator]();
  let started = false;
  let completed = false;
  let usage: CompletionUsage | undefined;
  let bufferedText = '';
  let streamedContent = false;
  const toolsDeclared = Boolean(request.tools?.length);
  const markerSuppressor = new ToolTextStreamFilter(
    toolsDeclared && request.tool_choice !== 'none',
  );
  const toolStream = new OpenAiToolStreamAccumulator();

  const writeContent = async (text: string): Promise<void> => {
    if (!text) return;
    await writeSse(
      reply,
      sseData(
        completionChunk(request, id, created, [
          { index: 0, delta: { content: text }, finish_reason: null },
        ]),
      ),
    );
  };
  const writeToolDeltas = async (deltas: readonly OpenAiToolCallDelta[]): Promise<void> => {
    if (deltas.length === 0) return;
    await writeSse(
      reply,
      sseData(
        completionChunk(request, id, created, [
          { index: 0, delta: { tool_calls: deltas }, finish_reason: null },
        ]),
      ),
    );
  };
  const consume = async (event: CompletionStreamEvent): Promise<void> => {
    switch (event.type) {
      case 'thinking':
        return;
      case 'content': {
        if (toolsDeclared) bufferedText += event.text;
        const safe = markerSuppressor.push(event.text);
        if (safe) {
          streamedContent = true;
          await writeContent(safe);
        }
        return;
      }
      case 'tool_call_start':
        await writeToolDeltas(toolStream.start(event.index, event.id, event.name));
        return;
      case 'tool_call_arguments_delta':
        await writeToolDeltas(toolStream.append(event.index, event.id, event.delta));
        return;
      case 'tool_call_complete':
        await writeToolDeltas(toolStream.complete(event.index, event.call));
        return;
      case 'done':
        if (event.is_error) {
          throw new CursorBackendError(event.message ?? 'Cursor returned an error');
        }
        usage = event.usage;
        traceUsageSource(trace, event.usage_source ?? 'unknown');
        completed = true;
    }
  };

  try {
    const first = await iterator.next();
    if (first.done) throw new CursorBackendError('Cursor stream ended without a result');
    reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    reply.hijack();
    reply.raw.flushHeaders();
    started = true;
    await writeSse(
      reply,
      sseData(
        completionChunk(request, id, created, [
          { index: 0, delta: { role: 'assistant' }, finish_reason: null },
        ]),
      ),
    );
    await consume(first.value);
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      await consume(next.value);
    }
    if (!completed) throw new CursorBackendError('Cursor stream ended without a result');

    if (toolsDeclared && !toolStream.hasCalls) {
      const deltas = streamedToolCalls(request, bufferedText).flatMap((call, index) =>
        toolStream.complete(index, call),
      );
      await writeToolDeltas(deltas);
    }
    const finishReason = toolStream.finish();
    if (toolsDeclared && finishReason === 'stop') {
      const trailing = markerSuppressor.finish();
      if (trailing) {
        streamedContent = true;
        await writeContent(trailing);
      } else if (
        !streamedContent &&
        bufferedText &&
        !markerSuppressor.suppressedToolPayload &&
        !bufferedText.includes(TOOL_CALL_MARKER)
      ) {
        for (const chunk of splitSseContent(bufferedText)) await writeContent(chunk);
      }
    } else if (!toolsDeclared) {
      await writeContent(markerSuppressor.finish());
    }
    await writeSse(
      reply,
      sseData(
        completionChunk(request, id, created, [
          { index: 0, delta: {}, finish_reason: finishReason },
        ]),
      ),
    );
    if (request.stream_options?.include_usage && usage) {
      await writeSse(reply, sseData(completionChunk(request, id, created, [], usage)));
    }
    await writeSse(reply, 'data: [DONE]\n\n');
    reply.raw.end();
    return { reply, terminal: 'success' };
  } catch (error) {
    if (!started) throw error;
    if (!signal.aborted && !reply.raw.destroyed && !reply.raw.writableEnded) {
      reply.request.log.warn({ err: error }, 'cursor backend stream failed after SSE started');
      await writeSse(reply, sseData(openAiError(backendErrorMessage(error), 'backend_error')));
      reply.raw.end();
    }
    return { reply, terminal: signal.aborted ? 'abort' : 'error' };
  } finally {
    if (!completed) await iterator.return?.();
  }
}
