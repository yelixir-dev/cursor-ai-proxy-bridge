import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ToolHistoryValidationError, assertValidToolHistory } from '../backend/tool-history.js';
import {
  attachRequestTrace,
  createRequestTrace,
  finishTrace,
  traceBackend,
  traceStage,
  traceUsageSource,
} from '../trace.js';
import { requireClientAuth, tokenFromRequest } from './auth.js';
import { requestAbortSignal } from './lifecycle.js';
import {
  backendErrorMessage,
  chatCompletionPayload,
  openAiError,
  toolConfigurationError,
} from './responses.js';
import { chatCompletionSchema } from './schema.js';
import { streamChatCompletion } from './streaming.js';
import type { ServerContext } from './types.js';

export function registerChatRoutes(context: ServerContext): void {
  const { app, config, backend, modelPolicy, limiter } = context;

  app.get('/v1/models', async (request, reply) => {
    if (!(await requireClientAuth(request, reply, config))) return reply;
    const models = await backend.listModels();
    return { object: 'list', data: models.filter((model) => modelPolicy.enabled(model.id)) };
  });

  app.post('/v1/chat/completions', async (request, reply) => {
    if (!(await requireClientAuth(request, reply, config))) return reply;
    const parsed = chatCompletionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(openAiError(z.prettifyError(parsed.error)));
    }
    const completionRequest = parsed.data;
    let modelDisabled = !modelPolicy.enabled(completionRequest.model);
    if (!modelDisabled && completionRequest.model !== config.defaultModel) {
      const liveModels = await backend.listModels();
      modelDisabled = !liveModels.some((model) => model.id === completionRequest.model);
    }
    if (modelDisabled) {
      return reply.code(400).send(openAiError(`model '${completionRequest.model}' is disabled`));
    }
    try {
      assertValidToolHistory(completionRequest.messages);
    } catch (error) {
      if (error instanceof ToolHistoryValidationError) {
        return reply.code(400).send(openAiError(error.message));
      }
      throw error;
    }
    const configurationError = toolConfigurationError(completionRequest);
    if (configurationError) {
      return reply.code(400).send(openAiError(configurationError));
    }

    const trace = createRequestTrace({
      environment: context.trace?.environment,
      requestId: String(request.id),
      model: completionRequest.model,
      sink: context.trace?.sink,
      now: context.trace?.now,
    });
    attachRequestTrace(completionRequest, trace);
    traceStage(trace, 'accepted');
    const releaseCapacity = limiter.acquire(tokenFromRequest(request) ?? '');
    if (!releaseCapacity) {
      finishTrace(trace, 'rate_limited', { quiescent: true });
      reply.header('Retry-After', '1');
      return reply
        .code(429)
        .send(openAiError('Too many in-flight chat completions', 'rate_limit_error'));
    }
    traceStage(trace, 'queue_acquired');
    if (backend.type !== 'auto') traceBackend(trace, backend.type);
    const requestAbort = requestAbortSignal(request, reply);
    let terminal: 'success' | 'error' | 'abort' | undefined;
    try {
      const created = Math.floor(Date.now() / 1000);
      const id = `chatcmpl-${randomUUID()}`;
      if (completionRequest.stream) {
        const streamed = await streamChatCompletion({
          backend,
          request: completionRequest,
          reply,
          signal: requestAbort.signal,
          id,
          created,
          trace,
        });
        terminal = streamed.terminal;
        return streamed.reply;
      }
      const result = await backend.complete(completionRequest, requestAbort.signal);
      traceUsageSource(trace, result.usage_source ?? 'unknown');
      terminal = 'success';
      return chatCompletionPayload(result, id, created);
    } catch (error) {
      if (requestAbort.signal.aborted) {
        terminal = 'abort';
        return reply;
      }
      terminal = 'error';
      request.log.warn({ err: error }, 'cursor backend completion failed');
      return reply.code(502).send(openAiError(backendErrorMessage(error), 'backend_error'));
    } finally {
      const finalTerminal = requestAbort.signal.aborted ? 'abort' : (terminal ?? 'error');
      requestAbort.cleanup();
      releaseCapacity();
      finishTrace(trace, finalTerminal, { quiescent: true });
    }
  });
}
