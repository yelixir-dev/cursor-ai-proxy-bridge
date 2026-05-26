import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { BridgeConfig } from './config.js';
import { redactedConfig } from './config.js';
import type { CursorBackend } from './backend/types.js';
import { renderDashboard } from './dashboard.js';

const chatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string().min(1).max(200_000),
});

const chatCompletionSchema = z.object({
  model: z.string().min(1).max(200).default('cursor-fast'),
  messages: z.array(chatMessageSchema).min(1).max(200),
  stream: z.boolean().optional().default(false),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().max(200_000).optional(),
});

export interface BuildServerOptions {
  config: BridgeConfig;
  backend: CursorBackend;
}

interface RequestStats {
  count: number;
  startedAt: number;
}

function tokenFromRequest(request: FastifyRequest): string | undefined {
  const auth = request.headers.authorization;
  if (auth?.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  const apiKey = request.headers['x-api-key'];
  return Array.isArray(apiKey) ? apiKey[0] : apiKey;
}

async function requireClientAuth(
  request: FastifyRequest,
  reply: FastifyReply,
  config: BridgeConfig,
): Promise<boolean> {
  if (!config.apiKey) {
    await reply.code(503).send({
      error: {
        type: 'configuration_error',
        message: 'CURSOR_BRIDGE_API_KEY must be configured before /v1 endpoints are available',
      },
    });
    return false;
  }
  if (tokenFromRequest(request) === config.apiKey) return true;
  await reply.code(401).send({
    error: {
      type: 'authentication_error',
      message: 'Missing or invalid Cursor Bridge client API key',
    },
  });
  return false;
}

function openAiError(message: string, type = 'invalid_request_error') {
  return { error: { message, type } };
}

export async function buildServer(options: BuildServerOptions): Promise<FastifyInstance> {
  const { config, backend } = options;
  const stats: RequestStats = { count: 0, startedAt: Date.now() };
  const app = Fastify({
    logger: false,
    bodyLimit: 2 * 1024 * 1024,
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
    methods: ['GET', 'POST', 'OPTIONS'],
  });
  await app.register(rateLimit, {
    max: 120,
    timeWindow: '1 minute',
  });

  app.get('/health', async () => {
    const backendHealth = await backend.health();
    return {
      status: backendHealth.ok ? 'ok' : 'degraded',
      bridge: redactedConfig(config),
      auth: { client_api_key_configured: Boolean(config.apiKey) },
      backend: backendHealth,
      workspace: {
        mode: config.workspaceMode,
        real_workspace_configured: Boolean(config.realWorkspacePath),
      },
      uptime_seconds: Math.floor((Date.now() - stats.startedAt) / 1000),
    };
  });

  app.get('/dashboard', async (_request, reply) => {
    const [backendHealth, models] = await Promise.all([backend.health(), backend.listModels()]);
    reply.type('text/html; charset=utf-8');
    return renderDashboard({
      config,
      backendHealth,
      models,
      uptimeSeconds: (Date.now() - stats.startedAt) / 1000,
      requestCount: stats.count,
    });
  });

  app.get('/v1/models', async (request, reply) => {
    if (!(await requireClientAuth(request, reply, config))) return reply;
    stats.count += 1;
    const models = await backend.listModels();
    return { object: 'list', data: models };
  });

  app.post('/v1/chat/completions', async (request, reply) => {
    if (!(await requireClientAuth(request, reply, config))) return reply;
    const parsed = chatCompletionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(openAiError(z.prettifyError(parsed.error)));
    }
    if (parsed.data.stream) {
      return reply.code(400).send(openAiError('stream=true is not implemented in this MVP'));
    }

    stats.count += 1;
    try {
      const result = await backend.complete(parsed.data);
      const now = Math.floor(Date.now() / 1000);
      return {
        id: `chatcmpl-${randomUUID()}`,
        object: 'chat.completion',
        created: now,
        model: result.model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: result.content },
            finish_reason: 'stop',
          },
        ],
        usage: result.usage ?? {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        },
      };
    } catch (error) {
      request.log.error({ error }, 'cursor backend completion failed');
      return reply.code(502).send(openAiError('Cursor backend completion failed', 'backend_error'));
    }
  });

  app.setNotFoundHandler(async (_request, reply) =>
    reply.code(404).send({ error: { type: 'not_found', message: 'route not found' } }),
  );

  return app;
}
