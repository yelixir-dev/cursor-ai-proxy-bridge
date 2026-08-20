import type { FastifyInstance } from 'fastify';
import { openAiError } from './responses.js';

export const REQUEST_BODY_LIMIT_BYTES = 32 * 1024 * 1024;

export function registerErrorHandlers(app: FastifyInstance): void {
  app.setErrorHandler(async (error, request, reply) => {
    const code = error instanceof Error ? Reflect.get(error, 'code') : undefined;
    const statusCode = error instanceof Error ? Reflect.get(error, 'statusCode') : undefined;
    if (
      request.url.startsWith('/v1/') &&
      statusCode === 400 &&
      code === 'FST_ERR_CTP_INVALID_JSON_BODY' &&
      error instanceof Error
    ) {
      return reply.code(400).send(openAiError(error.message));
    }
    if (code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      const received = request.headers['content-length'];
      const receivedNote =
        typeof received === 'string' && received.length > 0
          ? `; received Content-Length ${received}`
          : '';
      return reply
        .code(413)
        .send(
          openAiError(
            `Request body is too large. Limit is ${String(REQUEST_BODY_LIMIT_BYTES)} bytes${receivedNote}. Compact the session or drop embedded images.`,
          ),
        );
    }
    return reply.send(error);
  });

  app.setNotFoundHandler(async (_request, reply) =>
    reply.code(404).send({ error: { type: 'not_found', message: 'route not found' } }),
  );
}
