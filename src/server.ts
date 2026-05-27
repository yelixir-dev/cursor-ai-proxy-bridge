import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { BridgeConfig } from './config.js';
import { redactedConfig } from './config.js';
import type { CompletionResult, CursorBackend } from './backend/types.js';
import { renderDashboard } from './dashboard.js';

const IMAGE_OMITTED_PLACEHOLDER = '[image omitted: cursor composer bridge is text-only]';
const MAX_CONTENT_PARTS = 1_000;

function unsupportedContentPlaceholder(type: unknown): string {
  return typeof type === 'string' && type.length > 0
    ? `[unsupported content type omitted: ${type}]`
    : '[unsupported content block omitted]';
}

function flattenMessageContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block);
      continue;
    }
    if (!block || typeof block !== 'object') continue;

    const candidate = block as { type?: unknown; text?: unknown; content?: unknown };
    if (typeof candidate.text === 'string') {
      parts.push(candidate.text);
      continue;
    }
    if (typeof candidate.content === 'string') {
      parts.push(candidate.content);
      continue;
    }
    if (candidate.type === 'image_url' || candidate.type === 'input_image') {
      parts.push(IMAGE_OMITTED_PLACEHOLDER);
      continue;
    }
    if (typeof candidate.type === 'string') {
      parts.push(unsupportedContentPlaceholder(candidate.type));
    }
  }
  return parts.join('\n');
}

const chatContentSchema = z
  .union([z.string(), z.null(), z.array(z.unknown()).max(MAX_CONTENT_PARTS)])
  .transform((content) => (content === null ? '' : flattenMessageContent(content)))
  .pipe(z.string().max(200_000));

const chatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: chatContentSchema,
  tool_calls: z
    .array(
      z.object({
        id: z.string().min(1).max(200),
        type: z.literal('function'),
        function: z.object({
          name: z.string().min(1).max(200),
          arguments: z.string().max(200_000),
        }),
      }),
    )
    .min(1)
    .max(100)
    .optional(),
  tool_call_id: z.string().min(1).max(200).optional(),
});

const toolFunctionSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
});

const toolSchema = z.object({
  type: z.literal('function'),
  function: toolFunctionSchema,
});

const toolChoiceSchema = z.union([
  z.literal('none'),
  z.literal('auto'),
  z.literal('required'),
  z.object({
    type: z.literal('function'),
    function: z.object({ name: z.string().min(1).max(200) }),
  }),
]);

const chatCompletionSchema = z.object({
  model: z.string().min(1).max(200).default('cursor-fast'),
  messages: z.array(chatMessageSchema).min(1).max(200),
  stream: z.boolean().optional().default(false),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().max(200_000).optional(),
  tools: z.array(toolSchema).min(1).max(128).optional(),
  tool_choice: toolChoiceSchema.optional(),
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

function chatCompletionPayload(
  result: CompletionResult,
  id: string,
  created: number,
): Record<string, unknown> {
  const message: Record<string, unknown> = { role: 'assistant' };
  if (result.tool_calls && result.tool_calls.length > 0) {
    message.tool_calls = result.tool_calls;
    message.content = null;
  } else {
    message.content = result.content;
  }

  return {
    id,
    object: 'chat.completion',
    created,
    model: result.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: result.tool_calls?.length ? 'tool_calls' : 'stop',
      },
    ],
    usage: result.usage ?? {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}

function splitSseContent(content: string): string[] {
  const chunks = content.match(/\S+\s*/g);
  return chunks && chunks.length > 0 ? chunks : [''];
}

function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function chatCompletionSse(result: CompletionResult, id: string, created: number): string {
  const frames: string[] = [
    sseData({
      id,
      object: 'chat.completion.chunk',
      created,
      model: result.model,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    }),
  ];

  if (result.tool_calls && result.tool_calls.length > 0) {
    frames.push(
      sseData({
        id,
        object: 'chat.completion.chunk',
        created,
        model: result.model,
        choices: [{ index: 0, delta: { tool_calls: result.tool_calls }, finish_reason: null }],
      }),
    );
  } else if (result.content) {
    for (const chunk of splitSseContent(result.content)) {
      frames.push(
        sseData({
          id,
          object: 'chat.completion.chunk',
          created,
          model: result.model,
          choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
        }),
      );
    }
  }

  frames.push(
    sseData({
      id,
      object: 'chat.completion.chunk',
      created,
      model: result.model,
      choices: [
        { index: 0, delta: {}, finish_reason: result.tool_calls?.length ? 'tool_calls' : 'stop' },
      ],
    }),
    'data: [DONE]\n\n',
  );
  return frames.join('');
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
    stats.count += 1;
    try {
      const result = await backend.complete(parsed.data);
      const now = Math.floor(Date.now() / 1000);
      const id = `chatcmpl-${randomUUID()}`;
      if (parsed.data.stream) {
        reply
          .type('text/event-stream; charset=utf-8')
          .header('Connection', 'keep-alive')
          .header('X-Accel-Buffering', 'no');
        return chatCompletionSse(result, id, now);
      }
      return chatCompletionPayload(result, id, now);
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
