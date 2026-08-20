import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import { ModelPolicy } from './model-policy.js';
import { normalizedConfig } from './server/auth.js';
import { registerChatRoutes } from './server/chat.js';
import { positiveIntegerFromEnv } from './server/environment.js';
import { registerErrorHandlers, REQUEST_BODY_LIMIT_BYTES } from './server/errors.js';
import { BackendHealthCache } from './server/health.js';
import { CompletionLimiter } from './server/lifecycle.js';
import { registerManagementRoutes } from './server/management.js';
import type { BuildServerOptions, ServerContext } from './server/types.js';

export { timingSafeKeyEqual } from './server/auth.js';
export { flattenMessageContent } from './server/schema.js';
export type { BuildServerOptions } from './server/types.js';

export async function buildServer(options: BuildServerOptions): Promise<FastifyInstance> {
  const config = normalizedConfig(options.config);
  const app = Fastify({
    logger: {
      level: 'warn',
      redact: {
        paths: ['req.headers.authorization', 'req.headers.x-api-key', 'body.credentials[*].apiKey'],
        censor: '[REDACTED]',
      },
    },
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: REQUEST_BODY_LIMIT_BYTES,
  });
  if (config.clientAuth === 'off') {
    app.log.warn('client auth disabled — bind to localhost or a trusted network only');
  }
  app.addHook('preClose', async () => {
    await options.backend.shutdown?.();
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", 'http:'],
        upgradeInsecureRequests: null,
      },
    },
  });
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
  });
  await app.register(cors, {
    origin: false,
    methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
  });
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });

  const context: ServerContext = {
    app,
    config,
    backend: options.backend,
    modelPolicy: new ModelPolicy(config.dashboardConfig?.modelOverrides),
    health: new BackendHealthCache(options.backend),
    limiter: new CompletionLimiter(
      config.maxConcurrency ?? positiveIntegerFromEnv('CURSOR_BRIDGE_MAX_CONCURRENCY', 16),
      config.maxConcurrencyPerKey ??
        positiveIntegerFromEnv('CURSOR_BRIDGE_MAX_CONCURRENCY_PER_KEY', 16),
    ),
    startedAt: Date.now(),
    ...(options.trace ? { trace: options.trace } : {}),
  };
  registerManagementRoutes(context);
  registerChatRoutes(context);
  registerErrorHandlers(app);
  return app;
}
