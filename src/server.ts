import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import { z } from 'zod';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import type { BridgeConfig } from './config.js';
import { redactedConfig } from './config.js';
import type {
  BackendHealth,
  ChatCompletionRequest,
  CompletionResult,
  CompletionStreamEvent,
  CompletionUsage,
  CursorBackend,
  ToolCall,
} from './backend/types.js';
import { renderDashboard } from './dashboard.js';
import { ToolHistoryValidationError, assertValidToolHistory } from './backend/tool-history.js';
import { ToolArgumentValidationError } from './backend/tool-arguments.js';
import { CursorBackendError } from './backend/cursor-cli.js';
import { filterToolCallsToAllowed, parseToolCallsFromText } from './backend/tool-call-parse.js';
import { TOOL_CALL_MARKER, ToolTextStreamFilter } from './backend/tool-call-stream.js';
import {
  dashboardConfigPath,
  redactedCredentials,
  writeDashboardConfigFile,
  type DashboardConfig,
  type DashboardCredential,
} from './dashboard-config.js';
import {
  cursorCredentialsFromConfig,
  type CursorApiCredential,
} from './backend/cursor-api/credentials.js';
import { ModelPolicy } from './model-policy.js';

const IMAGE_OMITTED_PLACEHOLDER = '[image omitted: cursor composer bridge is text-only]';
const MAX_CONTENT_PARTS = 1_000;
const REQUEST_BODY_LIMIT_BYTES = 32 * 1024 * 1024;

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
  role: z.enum(['system', 'developer', 'user', 'assistant', 'tool']),
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

const TOOL_DESCRIPTION_MAX_INPUT_LENGTH = 200_000;
const TOOL_DESCRIPTION_BACKEND_LENGTH = 2_000;
const TOOL_DESCRIPTION_TRUNCATED_MARKER = '\n[description truncated by cursor composer bridge]';

function normalizeToolDescription(description: string | undefined): string | undefined {
  if (description === undefined || description.length <= TOOL_DESCRIPTION_BACKEND_LENGTH) {
    return description;
  }
  return `${description.slice(
    0,
    TOOL_DESCRIPTION_BACKEND_LENGTH - TOOL_DESCRIPTION_TRUNCATED_MARKER.length,
  )}${TOOL_DESCRIPTION_TRUNCATED_MARKER}`;
}

const toolFunctionSchema = z.object({
  name: z.string().min(1).max(200),
  description: z
    .string()
    .max(TOOL_DESCRIPTION_MAX_INPUT_LENGTH)
    .optional()
    .transform((description) => normalizeToolDescription(description)),
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

const adminConfigPatchSchema = z
  .object({
    credentials: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(100),
            label: z.string().trim().min(1).max(200).optional(),
            apiKey: z.string().trim().min(1).optional(),
            weight: z.number().positive().optional(),
            enabled: z.boolean().optional(),
            _delete: z.boolean().optional(),
          })
          .strict(),
      )
      .optional(),
    modelOverrides: z.record(z.string(), z.boolean().nullable()).optional(),
  })
  .strict();

const chatCompletionSchema = z.object({
  model: z.string().min(1).max(200).default('composer-2.5'),
  messages: z.array(chatMessageSchema).min(1).max(200),
  stream: z.boolean().optional().default(false),
  stream_options: z.object({ include_usage: z.boolean().optional().default(false) }).optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().max(200_000).optional(),
  tools: z.array(toolSchema).max(128).optional(),
  tool_choice: toolChoiceSchema.optional(),
  parallel_tool_calls: z.boolean().optional(),
});

type ParsedChatCompletionRequest = z.infer<typeof chatCompletionSchema>;

function withStableToolDefaults(request: ParsedChatCompletionRequest): ParsedChatCompletionRequest {
  if (
    request.model !== 'composer-2.5' ||
    !request.tools?.length ||
    request.parallel_tool_calls !== undefined
  ) {
    return request;
  }
  return { ...request, parallel_tool_calls: false };
}

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

export function timingSafeKeyEqual(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left).digest();
  const rightDigest = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

async function requireClientAuth(
  request: FastifyRequest,
  reply: FastifyReply,
  config: BridgeConfig,
): Promise<boolean> {
  if (config.clientAuth === 'off') return true;
  const apiKey = config.apiKey;
  if (!apiKey) throw new Error('CURSOR_BRIDGE_AUTH=on requires CURSOR_BRIDGE_API_KEY');
  const token = tokenFromRequest(request);
  if (token !== undefined && timingSafeKeyEqual(token, apiKey)) return true;
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

function toolConfigurationError(request: z.infer<typeof chatCompletionSchema>): string | undefined {
  const tools = request.tools ?? [];
  const names = new Set(tools.map((tool) => tool.function.name));
  const choice = request.tool_choice;

  if ((choice === 'required' || typeof choice === 'object') && tools.length === 0) {
    return 'Required tool selection requires at least one defined tool';
  }
  if (names.size !== tools.length) {
    return 'Duplicate tool function names are not allowed';
  }
  if (typeof choice === 'object' && !names.has(choice.function.name)) {
    return `Requested tool is not defined: ${choice.function.name}`;
  }
  return undefined;
}

function chatCompletionPayload(
  result: CompletionResult,
  id: string,
  created: number,
): Record<string, unknown> {
  const message: Record<string, unknown> = { role: 'assistant' };
  if (result.tool_calls && result.tool_calls.length > 0) {
    message.tool_calls = result.tool_calls;
    message.content = '';
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
  return chunks && chunks.length > 0 ? chunks : [];
}

function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function streamedToolCalls(request: ChatCompletionRequest, text: string): ToolCall[] {
  if (request.tool_choice === 'none') return [];
  let calls = filterToolCallsToAllowed(parseToolCallsFromText(text), request.tools);
  const forcedName =
    typeof request.tool_choice === 'object' ? request.tool_choice.function.name : undefined;
  if (forcedName) calls = calls.filter((call) => call.function.name === forcedName);
  return request.parallel_tool_calls === false ? calls.slice(0, 1) : calls;
}

function completionChunk(
  request: ChatCompletionRequest,
  id: string,
  created: number,
  choices: unknown[],
  usage?: CompletionUsage,
): Record<string, unknown> {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model: request.model,
    choices,
    ...(usage ? { usage } : {}),
  };
}

async function writeSse(reply: FastifyReply, frame: string): Promise<void> {
  if (reply.raw.destroyed || reply.raw.writableEnded) return;
  if (reply.raw.write(frame)) return;
  await Promise.race([once(reply.raw, 'drain'), once(reply.raw, 'close')]);
}

async function streamChatCompletion(
  backend: CursorBackend,
  request: ChatCompletionRequest,
  reply: FastifyReply,
  signal: AbortSignal,
  id: string,
  created: number,
): Promise<FastifyReply> {
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

  const writeContent = async (text: string) => {
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
  const consume = async (event: CompletionStreamEvent) => {
    if (event.type === 'thinking') return;
    if (event.type === 'content') {
      if (toolsDeclared) bufferedText += event.text;
      const safe = markerSuppressor.push(event.text);
      if (safe) {
        streamedContent = true;
        await writeContent(safe);
      }
      return;
    }
    if (event.is_error) throw new CursorBackendError(event.message ?? 'Cursor returned an error');
    usage = event.usage;
    completed = true;
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

    let finishReason: 'stop' | 'tool_calls' = 'stop';
    if (toolsDeclared) {
      const toolCalls = streamedToolCalls(request, bufferedText);
      if (toolCalls.length > 0) {
        finishReason = 'tool_calls';
        await writeSse(
          reply,
          sseData(
            completionChunk(request, id, created, [
              {
                index: 0,
                delta: {
                  tool_calls: toolCalls.map((call, index) => ({ index, ...call })),
                },
                finish_reason: null,
              },
            ]),
          ),
        );
      } else {
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
      }
    } else {
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
    return reply;
  } catch (error) {
    if (!started) throw error;
    if (!signal.aborted && !reply.raw.destroyed && !reply.raw.writableEnded) {
      reply.request.log.warn({ err: error }, 'cursor backend stream failed after SSE started');
      await writeSse(
        reply,
        sseData(
          completionChunk(request, id, created, [{ index: 0, delta: {}, finish_reason: 'stop' }]),
        ),
      );
      await writeSse(reply, 'data: [DONE]\n\n');
      reply.raw.end();
    }
    return reply;
  } finally {
    if (!completed) await iterator.return?.();
  }
}

interface RequestAbort {
  signal: AbortSignal;
  cleanup(): void;
}

function requestAbortSignal(request: FastifyRequest, reply: FastifyReply): RequestAbort {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const requestClosed = () => {
    if (request.raw.aborted || !request.raw.complete) abort();
  };
  const responseClosed = () => {
    if (!reply.raw.writableEnded) abort();
  };
  request.raw.once('aborted', abort);
  request.raw.once('close', requestClosed);
  reply.raw.once('close', responseClosed);
  return {
    signal: controller.signal,
    cleanup() {
      request.raw.removeListener('aborted', abort);
      request.raw.removeListener('close', requestClosed);
      reply.raw.removeListener('close', responseClosed);
    },
  };
}

class CompletionLimiter {
  private globalInFlight = 0;
  private readonly perKeyInFlight = new Map<string, number>();

  constructor(
    private readonly globalLimit: number,
    private readonly perKeyLimit: number,
  ) {}

  acquire(apiKey: string): (() => void) | undefined {
    const keyId = createHash('sha256').update(apiKey).digest('hex');
    const keyInFlight = this.perKeyInFlight.get(keyId) ?? 0;
    if (this.globalInFlight >= this.globalLimit || keyInFlight >= this.perKeyLimit) {
      return undefined;
    }
    this.globalInFlight += 1;
    this.perKeyInFlight.set(keyId, keyInFlight + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.globalInFlight = Math.max(0, this.globalInFlight - 1);
      const remaining = Math.max(0, (this.perKeyInFlight.get(keyId) ?? 1) - 1);
      if (remaining === 0) this.perKeyInFlight.delete(keyId);
      else this.perKeyInFlight.set(keyId, remaining);
    };
  }
}

function positiveIntegerFromEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function buildServer(options: BuildServerOptions): Promise<FastifyInstance> {
  const configuredApiKey = options.config.apiKey?.trim();
  if (options.config.apiKey !== undefined && !configuredApiKey) {
    throw new Error('CURSOR_BRIDGE_API_KEY must not be empty or whitespace');
  }
  const clientAuth = options.config.clientAuth ?? (configuredApiKey ? 'on' : 'off');
  if (clientAuth === 'on' && !configuredApiKey) {
    throw new Error('CURSOR_BRIDGE_AUTH=on requires CURSOR_BRIDGE_API_KEY');
  }
  const config: BridgeConfig = {
    ...options.config,
    apiKey: configuredApiKey,
    clientAuth,
  };
  const { backend } = options;
  let dashboardConfig: DashboardConfig = config.dashboardConfig ?? {};
  const configPath = config.dashboardConfigPath ?? dashboardConfigPath(process.env);
  let effectiveCredentials: CursorApiCredential[] =
    config.cursorApiCredentials ??
    (backend.updateCredentials
      ? cursorCredentialsFromConfig({}, dashboardConfig.credentials ?? [])
      : []);
  const modelPolicy = new ModelPolicy(dashboardConfig.modelOverrides);
  const stats: RequestStats = { count: 0, startedAt: Date.now() };
  const completionLimiter = new CompletionLimiter(
    config.maxConcurrency ?? positiveIntegerFromEnv('CURSOR_BRIDGE_MAX_CONCURRENCY', 8),
    config.maxConcurrencyPerKey ??
      positiveIntegerFromEnv('CURSOR_BRIDGE_MAX_CONCURRENCY_PER_KEY', 4),
  );
  let healthCache: { value: BackendHealth; expiresAt: number } | undefined;
  let healthRefresh: Promise<BackendHealth> | undefined;
  const cachedBackendHealth = async (): Promise<BackendHealth> => {
    if (healthCache && healthCache.expiresAt > Date.now()) return healthCache.value;
    if (!healthRefresh) {
      healthRefresh = backend
        .health()
        .then((value) => {
          healthCache = {
            value,
            expiresAt: Date.now() + (backend.type === 'auto' ? 0 : 10_000),
          };
          return value;
        })
        .finally(() => {
          healthRefresh = undefined;
        });
    }
    return healthRefresh;
  };
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
    await backend.shutdown?.();
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
  await app.register(rateLimit, {
    max: 120,
    timeWindow: '1 minute',
  });

  app.get('/health', async () => {
    const backendHealth = await cachedBackendHealth();
    return {
      status: backendHealth.ok ? 'ok' : 'degraded',
      bridge: redactedConfig(config),
      auth: {
        client_auth_enabled: config.clientAuth === 'on',
        client_api_key_configured: Boolean(config.apiKey),
      },
      backend: backendHealth,
      workspace: {
        mode: config.workspaceMode,
        real_workspace_configured: Boolean(config.realWorkspacePath),
      },
      credentials: backend.credentialStates?.() ?? [],
      uptime_seconds: Math.floor((Date.now() - stats.startedAt) / 1000),
    };
  });

  app.get('/dashboard', async (_request, reply) => {
    reply.type('text/html; charset=utf-8');
    return renderDashboard(config.version);
  });

  const adminConfigResponse = async () => {
    const [backendHealth, models] = await Promise.all([backend.health(), backend.listModels()]);
    return {
      config: {
        server: { host: config.host, port: config.port },
        credentials: redactedCredentials(effectiveCredentials),
        modelOverrides: modelPolicy.snapshot(),
      },
      state: {
        activeBackend: backendHealth.activeBackend ?? backend.type,
        credentials: backend.credentialStates?.() ?? [],
        models: models.map((model) => ({
          id: model.id,
          enabled: modelPolicy.enabled(model.id),
          source: modelPolicy.source(model.id),
        })),
      },
    };
  };

  app.get('/admin/config', async (request, reply) => {
    if (!(await requireClientAuth(request, reply, config))) return reply;
    return adminConfigResponse();
  });

  app.patch('/admin/config', async (request, reply) => {
    if (!(await requireClientAuth(request, reply, config))) return reply;
    const parsed = adminConfigPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(openAiError(z.prettifyError(parsed.error)));
    }

    const credentials = [...(dashboardConfig.credentials ?? [])];
    for (const update of parsed.data.credentials ?? []) {
      if (update.id === 'env') {
        if (update.apiKey !== undefined) {
          return reply
            .code(400)
            .send(openAiError("credential 'env' API key is controlled by CURSOR_API_KEY"));
        }
        return reply
          .code(400)
          .send(openAiError("credential 'env' cannot be changed through dashboard config"));
      }
      if (update.id === 'system') {
        return reply.code(400).send(openAiError("credential id 'system' is reserved"));
      }
      const index = credentials.findIndex((credential) => credential.id === update.id);
      if (update._delete) {
        if (index >= 0) credentials.splice(index, 1);
        continue;
      }
      const existing = index >= 0 ? credentials[index] : undefined;
      const apiKey = update.apiKey ?? existing?.apiKey;
      if (!apiKey) {
        return reply
          .code(400)
          .send(openAiError(`apiKey is required for new credential '${update.id}'`));
      }
      const next: DashboardCredential = {
        id: update.id,
        apiKey,
        weight: update.weight ?? existing?.weight ?? 1,
        enabled: update.enabled ?? existing?.enabled ?? true,
      };
      const label = update.label ?? existing?.label;
      if (label !== undefined) next.label = label;
      if (index >= 0) credentials[index] = next;
      else credentials.push(next);
    }

    const modelOverrides = { ...(dashboardConfig.modelOverrides ?? {}) };
    for (const [id, enabled] of Object.entries(parsed.data.modelOverrides ?? {})) {
      if (enabled === null) delete modelOverrides[id];
      else modelOverrides[id] = enabled;
    }
    const nextConfig: DashboardConfig = {
      ...dashboardConfig,
      credentials,
      modelOverrides,
    };
    writeDashboardConfigFile(configPath, nextConfig);
    dashboardConfig = nextConfig;
    const envCredential = effectiveCredentials.find((credential) => credential.id === 'env');
    effectiveCredentials = cursorCredentialsFromConfig(
      envCredential?.apiKey ? { CURSOR_API_KEY: envCredential.apiKey } : {},
      credentials,
    );
    backend.updateCredentials?.(effectiveCredentials);
    modelPolicy.replaceOverrides(modelOverrides);
    healthCache = undefined;
    return adminConfigResponse();
  });

  app.get('/v1/models', async (request, reply) => {
    if (!(await requireClientAuth(request, reply, config))) return reply;
    stats.count += 1;
    const models = await backend.listModels();
    return { object: 'list', data: models.filter((model) => modelPolicy.enabled(model.id)) };
  });

  app.post('/v1/chat/completions', async (request, reply) => {
    if (!(await requireClientAuth(request, reply, config))) return reply;
    const parsed = chatCompletionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(openAiError(z.prettifyError(parsed.error)));
    }
    const completionRequest = withStableToolDefaults(parsed.data);
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
    stats.count += 1;
    const releaseCapacity = completionLimiter.acquire(tokenFromRequest(request) ?? '');
    if (!releaseCapacity) {
      reply.header('Retry-After', '1');
      return reply
        .code(429)
        .send(openAiError('Too many in-flight chat completions', 'rate_limit_error'));
    }
    const requestAbort = requestAbortSignal(request, reply);
    try {
      const now = Math.floor(Date.now() / 1000);
      const id = `chatcmpl-${randomUUID()}`;
      if (completionRequest.stream) {
        return await streamChatCompletion(
          backend,
          completionRequest,
          reply,
          requestAbort.signal,
          id,
          now,
        );
      }
      const result = await backend.complete(completionRequest, requestAbort.signal);
      return chatCompletionPayload(result, id, now);
    } catch (error) {
      if (requestAbort.signal.aborted) return reply;
      request.log.warn({ err: error }, 'cursor backend completion failed');
      const message =
        error instanceof ToolArgumentValidationError || error instanceof CursorBackendError
          ? error.message
          : 'Cursor backend completion failed';
      return reply.code(502).send(openAiError(message, 'backend_error'));
    } finally {
      requestAbort.cleanup();
      releaseCapacity();
    }
  });

  app.setErrorHandler(async (error, request, reply) => {
    const fastifyError = error as Error & { code?: string; statusCode?: number };
    if (
      request.url.startsWith('/v1/') &&
      fastifyError.statusCode === 400 &&
      fastifyError.code === 'FST_ERR_CTP_INVALID_JSON_BODY'
    ) {
      return reply.code(400).send(openAiError(fastifyError.message));
    }
    if (fastifyError.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
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

  return app;
}
