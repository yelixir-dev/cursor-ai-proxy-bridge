import { randomUUID } from 'node:crypto';
import type {
  BackendHealth,
  BridgeModel,
  ChatCompletionRequest,
  CompletionResult,
  CompletionStreamEvent,
  CompletionUsage,
  CursorBackend,
  ToolCall,
} from '../types.js';
import { CursorBackendError, CursorCommandAbortedError } from '../cursor-cli.js';
import {
  ToolArgumentValidationError,
  validateToolCallArguments,
  type ToolArgumentValidationFailure,
} from '../tool-arguments.js';
import { parseToolCallsFromText } from '../tool-call-parse.js';
import { TOOL_CALL_MARKER, ToolTextStreamFilter } from '../tool-call-stream.js';
import type { BridgeConfig } from '../../config.js';
import { CursorAuthProvider } from './auth.js';
import { ConnectFrameDecoder, encodeConnectFrame } from './connect-frame.js';
import {
  CursorCredentialRouter,
  cursorCredentialsFromConfig,
  type CursorApiCredential,
  type CursorApiCredentialStateView,
} from './credentials.js';
import {
  enforceNativeToolChoice,
  heartbeatMessage,
  mapRequestedModels,
  mapUsableModels,
  mcpArgsToToolCall,
  nativeToolDefinition,
  nativeToolBatchComplete,
  requestContextResult,
  runRequestMessage,
  usageFromTurnEnded,
} from './mapper.js';
import { loadProtoDescriptors, ProtoCodec, type ProtoDescriptorSet } from './protobuf.js';
import { mapCursorApiToolRequest } from './tool-wire-names.js';
import {
  NodeCursorApiTransport,
  CursorApiHttpError,
  type CursorApiTransport,
  type CursorRunStream,
} from './transport.js';

const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const MODEL_TTL_MS = 60 * 1000;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 8_388_608;
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

export const CURSOR_API_STARTUP_SEQUENCE = [
  '/aiserver.v1.DashboardService/GetMe',
  '/aiserver.v1.ServerConfigService/GetServerConfig',
  '/aiserver.v1.AiService/AvailableModels',
  '/aiserver.v1.AiService/GetUsableModels',
  '/aiserver.v1.AiService/GetDefaultModelForCli',
  '/aiserver.v1.DashboardService/GetMe',
  '/aiserver.v1.ServerConfigService/GetServerConfig',
  '/aiserver.v1.AnalyticsService/SubmitLogs',
  '/aiserver.v1.AnalyticsService/TrackEvents',
  '/aiserver.v1.AnalyticsService/SubmitLogs',
  '/aiserver.v1.AnalyticsService/SubmitLogs',
] as const;

function boundedInteger(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

interface RunOutcome {
  text: string;
  toolCalls: ToolCall[];
  usage: CompletionUsage;
}

export interface CursorApiBackendDependencies {
  descriptors?: ProtoDescriptorSet;
  descriptorPath?: string;
  auth?: CursorAuthProvider;
  transport?: CursorApiTransport;
  environment?: NodeJS.ProcessEnv;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
  credentialRouter?: CursorCredentialRouter;
  now?: () => number;
}

class AsyncQueue<T> implements AsyncIterableIterator<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
  }> = [];
  private ended = false;
  private failure: unknown;

  push(value: T): void {
    if (this.ended || this.failure !== undefined) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.values.push(value);
  }
  end(): void {
    if (this.ended || this.failure !== undefined) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ value: undefined, done: true });
  }
  fail(error: unknown): void {
    if (this.ended || this.failure !== undefined) return;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }
  next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve({ value, done: false });
    if (this.failure !== undefined) return Promise.reject(this.failure);
    if (this.ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }
}

function retryFeedback(failure: ToolArgumentValidationFailure): string {
  return `TOOL ARGUMENT VALIDATION FEEDBACK: Your previous call to ${JSON.stringify(failure.toolName)} was invalid: ${failure.message}. Return a corrected tool call matching the declared schema.`;
}

function choiceRequiresTool(request: ChatCompletionRequest): boolean {
  return request.tool_choice === 'required' || typeof request.tool_choice === 'object';
}

export class CursorApiBackend implements CursorBackend {
  readonly type = 'cursor-api';
  private readonly codec: ProtoCodec;
  private readonly auth: CursorAuthProvider;
  private readonly transport: CursorApiTransport;
  private readonly credentialRouter: CursorCredentialRouter;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly intervals: Pick<typeof globalThis, 'setInterval' | 'clearInterval'>;
  private readonly timers: Pick<typeof globalThis, 'setTimeout' | 'clearTimeout'>;
  private readonly activeStreams = new Set<CursorRunStream>();
  private discoveryCache?: { url: string; expiresAt: number };
  private discoveryRefresh?: Promise<string>;
  private modelCache?: { models: BridgeModel[]; expiresAt: number };
  private modelRefresh?: Promise<BridgeModel[]>;
  private requestedModels = new Map<
    string,
    {
      modelId: string;
      maxMode: boolean;
      parameters: Array<{ id: string; value: string }>;
      builtInModel: boolean;
      isVariantStringRepresentation: boolean;
    }
  >();
  private initialization?: Promise<void>;
  private initialized = false;

  constructor(
    private readonly config: BridgeConfig,
    dependencies: CursorApiBackendDependencies = {},
  ) {
    this.environment = dependencies.environment ?? process.env;
    const envDescriptorPath = this.environment.CURSOR_BRIDGE_CURSOR_API_DESCRIPTORS?.trim();
    const descriptors =
      dependencies.descriptors ??
      loadProtoDescriptors(
        dependencies.descriptorPath ?? (envDescriptorPath ? envDescriptorPath : undefined),
      );
    this.codec = new ProtoCodec(descriptors);
    this.auth =
      dependencies.auth ??
      new CursorAuthProvider({
        environment: this.environment,
        apiEndpoint:
          this.environment.CURSOR_BRIDGE_CURSOR_API_ENDPOINT ??
          this.environment.CURSOR_API_ENDPOINT,
      });
    this.transport =
      dependencies.transport ??
      new NodeCursorApiTransport({
        auth: this.auth,
        clientVersion: descriptors.clientVersion,
        apiEndpoint:
          this.environment.CURSOR_BRIDGE_CURSOR_API_ENDPOINT ??
          this.environment.CURSOR_API_ENDPOINT,
        agentEndpoint: this.environment.CURSOR_BRIDGE_CURSOR_AGENT_ENDPOINT,
      });
    this.credentialRouter =
      dependencies.credentialRouter ??
      new CursorCredentialRouter({
        credentials:
          config.cursorApiCredentials ??
          cursorCredentialsFromConfig(this.environment, config.dashboardConfig?.credentials ?? []),
        cooldownMs: boundedInteger(this.environment.CURSOR_BRIDGE_CREDENTIAL_COOLDOWN_MS, 300_000),
        now: dependencies.now,
      });
    this.intervals = {
      setInterval: dependencies.setInterval ?? globalThis.setInterval,
      clearInterval: dependencies.clearInterval ?? globalThis.clearInterval,
    };
    this.timers = {
      setTimeout: dependencies.setTimeout ?? globalThis.setTimeout,
      clearTimeout: dependencies.clearTimeout ?? globalThis.clearTimeout,
    };
  }

  async initialize(timeoutMs = DEFAULT_PROBE_TIMEOUT_MS): Promise<void> {
    if (this.initialized) return;
    if (!this.initialization) {
      this.initialization = this.startup(timeoutMs)
        .then(() => {
          this.initialized = true;
        })
        .finally(() => {
          this.initialization = undefined;
        });
    }
    return this.initialization;
  }

  async probe(timeoutMs = DEFAULT_PROBE_TIMEOUT_MS): Promise<void> {
    await this.withCredential(async (_credential, accessToken) => {
      const response = await this.transport.unary(
        '/aiserver.v1.ServerConfigService/GetServerConfig',
        this.codec.encode('aiserver.v1.GetServerConfigRequest'),
        AbortSignal.timeout(timeoutMs),
        false,
        accessToken,
      );
      this.cacheAgentUrl(response);
    });
  }

  private async startup(timeoutMs: number): Promise<void> {
    await this.withCredential(async (_credential, accessToken) => {
      const signal = AbortSignal.timeout(timeoutMs);
      await this.transport.unary(
        CURSOR_API_STARTUP_SEQUENCE[0],
        this.codec.encode('aiserver.v1.GetMeRequest'),
        signal,
        true,
        accessToken,
      );
      const serverConfig = await this.transport.unary(
        CURSOR_API_STARTUP_SEQUENCE[1],
        this.codec.encode('aiserver.v1.GetServerConfigRequest'),
        signal,
        false,
        accessToken,
      );
      this.cacheAgentUrl(serverConfig);
      const available = await this.transport.unary(
        CURSOR_API_STARTUP_SEQUENCE[2],
        this.codec.encode('aiserver.v1.AvailableModelsRequest', {
          useModelParameters: true,
          doNotUseMarkdown: true,
        }),
        signal,
        false,
        accessToken,
      );
      const usable = await this.transport.unary(
        CURSOR_API_STARTUP_SEQUENCE[3],
        this.codec.encode('agent.v1.GetUsableModelsRequest'),
        signal,
        false,
        accessToken,
      );
      const defaultModel = await this.transport.unary(
        CURSOR_API_STARTUP_SEQUENCE[4],
        this.codec.encode('agent.v1.GetDefaultModelForCliRequest'),
        signal,
        false,
        accessToken,
      );
      this.cacheModels(usable, defaultModel, available);
      await this.transport.unary(
        CURSOR_API_STARTUP_SEQUENCE[5],
        this.codec.encode('aiserver.v1.GetMeRequest'),
        signal,
        false,
        accessToken,
      );
      const refreshedConfig = await this.transport.unary(
        CURSOR_API_STARTUP_SEQUENCE[6],
        this.codec.encode('aiserver.v1.GetServerConfigRequest'),
        signal,
        false,
        accessToken,
      );
      this.cacheAgentUrl(refreshedConfig);
      const telemetry = this.transport.telemetry?.bind(this.transport);
      if (telemetry) {
        await telemetry(CURSOR_API_STARTUP_SEQUENCE[7], { logs: [] }, signal, accessToken);
        await telemetry(CURSOR_API_STARTUP_SEQUENCE[8], { events: [] }, signal, accessToken);
        await telemetry(CURSOR_API_STARTUP_SEQUENCE[9], { logs: [] }, signal, accessToken);
        await telemetry(CURSOR_API_STARTUP_SEQUENCE[10], { logs: [] }, signal, accessToken);
      }
    });
  }

  async health(): Promise<BackendHealth> {
    try {
      await this.withCredential(async (_credential, accessToken) => this.agentUrl(accessToken));
      return {
        ok: true,
        type: this.type,
        authConfigured: this.credentialRouter
          .credentials()
          .some((credential) => credential.enabled),
        detail: 'direct Cursor API available',
      };
    } catch (error) {
      return {
        ok: false,
        type: this.type,
        authConfigured: this.credentialRouter
          .credentials()
          .some((credential) => credential.enabled),
        detail: error instanceof Error ? error.message : 'direct Cursor API unavailable',
      };
    }
  }

  credentialStates(): CursorApiCredentialStateView[] {
    return this.credentialRouter.snapshot();
  }

  updateCredentials(credentials: CursorApiCredential[]): void {
    this.auth.invalidate();
    this.credentialRouter.replaceCredentials(credentials);
  }

  async listModels(): Promise<BridgeModel[]> {
    if (this.modelCache && this.modelCache.expiresAt > Date.now()) {
      return [...this.modelCache.models];
    }
    if (!this.modelRefresh) {
      this.modelRefresh = this.withCredential(async (_credential, accessToken) => {
        const [modelsResponse, defaultResponse] = await Promise.all([
          this.transport.unary(
            '/aiserver.v1.AiService/GetUsableModels',
            this.codec.encode('agent.v1.GetUsableModelsRequest'),
            undefined,
            false,
            accessToken,
          ),
          this.transport.unary(
            '/aiserver.v1.AiService/GetDefaultModelForCli',
            this.codec.encode('agent.v1.GetDefaultModelForCliRequest'),
            undefined,
            false,
            accessToken,
          ),
        ]);
        return this.cacheModels(modelsResponse, defaultResponse);
      }).finally(() => {
        this.modelRefresh = undefined;
      });
    }
    return [...(await this.modelRefresh)];
  }

  async complete(request: ChatCompletionRequest, signal?: AbortSignal): Promise<CompletionResult> {
    const outcome = await this.validatedRun(request, signal);
    if (outcome.toolCalls.length) {
      return {
        content: null,
        model: request.model,
        tool_calls: outcome.toolCalls,
        usage: outcome.usage,
      };
    }
    return {
      content: outcome.text || null,
      model: request.model,
      usage: outcome.usage,
    };
  }

  async *completeStream(
    request: ChatCompletionRequest,
    signal?: AbortSignal,
  ): AsyncIterable<CompletionStreamEvent> {
    if (request.tools?.length && choiceRequiresTool(request)) {
      const outcome = await this.validatedRun(request, signal);
      if (outcome.toolCalls.length) {
        yield { type: 'content', text: `[TOOL_CALLS: ${JSON.stringify(outcome.toolCalls)}]` };
      } else if (outcome.text) {
        yield { type: 'content', text: outcome.text };
      }
      yield { type: 'done', usage: outcome.usage, is_error: false };
      return;
    }

    const queue = new AsyncQueue<CompletionStreamEvent>();
    const filter = request.tools?.length
      ? new ToolTextStreamFilter(request.tool_choice !== 'none')
      : undefined;
    let streamedContent = false;
    const emit = (event: CompletionStreamEvent) => {
      if (event.type !== 'content' || !filter) {
        queue.push(event);
        return;
      }
      const safe = filter.push(event.text);
      if (!safe) return;
      streamedContent = true;
      queue.push({ type: 'content', text: safe });
    };
    const execution = (
      filter ? this.validatedRun(request, signal, emit) : this.run(request, signal, emit)
    )
      .then((outcome) => {
        const trailing = filter?.finish() ?? '';
        if (trailing) {
          streamedContent = true;
          queue.push({ type: 'content', text: trailing });
        }
        if (outcome.toolCalls.length) {
          queue.push({
            type: 'content',
            text: `${TOOL_CALL_MARKER} ${JSON.stringify(outcome.toolCalls)}]`,
          });
        } else if (
          filter &&
          outcome.text &&
          !streamedContent &&
          !filter.suppressedToolPayload &&
          !outcome.text.includes(TOOL_CALL_MARKER)
        ) {
          queue.push({ type: 'content', text: outcome.text });
        }
        queue.push({ type: 'done', usage: outcome.usage, is_error: false });
        queue.end();
      })
      .catch((error: unknown) => queue.fail(error));
    try {
      for await (const event of queue) yield event;
    } finally {
      await execution;
    }
  }

  async shutdown(): Promise<void> {
    for (const stream of this.activeStreams)
      stream.destroy(new CursorCommandAbortedError('cursor API backend shutting down'));
    this.activeStreams.clear();
  }

  private async validatedRun(
    request: ChatCompletionRequest,
    signal?: AbortSignal,
    emit?: (event: CompletionStreamEvent) => void,
  ): Promise<RunOutcome> {
    const runMapped = async (candidateRequest: ChatCompletionRequest): Promise<RunOutcome> => {
      const mapped = mapCursorApiToolRequest(candidateRequest);
      const candidate = await this.run(mapped.request, signal, emit);
      if (candidate.toolCalls.length) {
        return { ...candidate, toolCalls: mapped.restoreToolCalls(candidate.toolCalls) };
      }
      if (!candidate.text || !mapped.request.tools?.length) return candidate;
      const parsed = parseToolCallsFromText(candidate.text);
      const recovered = enforceNativeToolChoice(mapped.restoreToolCalls(parsed), candidateRequest);
      return recovered.length ? { ...candidate, text: '', toolCalls: recovered } : candidate;
    };

    let outcome = await runMapped(request);
    if (outcome.toolCalls.length) {
      const failure = validateToolCallArguments(outcome.toolCalls, request.tools);
      if (failure) {
        const retryRequest: ChatCompletionRequest = {
          ...request,
          messages: [...request.messages, { role: 'user', content: retryFeedback(failure) }],
        };
        outcome = await runMapped(retryRequest);
        if (!outcome.toolCalls.length) {
          throw new ToolArgumentValidationError({
            toolName: failure.toolName,
            message: `${failure.message}; retry did not return a corrected tool call`,
          });
        }
        const retryFailure = validateToolCallArguments(outcome.toolCalls, request.tools);
        if (retryFailure) throw new ToolArgumentValidationError(retryFailure);
      }
    }
    if (choiceRequiresTool(request) && outcome.toolCalls.length === 0) {
      throw new CursorBackendError('Cursor did not return the required tool call');
    }
    return outcome;
  }

  private cacheModels(
    modelsResponse: Buffer,
    defaultResponse: Buffer,
    availableResponse?: Buffer,
  ): BridgeModel[] {
    const decodedUsableModels = this.codec.decode(
      'agent.v1.GetUsableModelsResponse',
      modelsResponse,
    );
    const models = mapUsableModels(decodedUsableModels);
    if (availableResponse) {
      this.requestedModels = mapRequestedModels(
        this.codec.decode('aiserver.v1.AvailableModelsResponse', availableResponse),
        decodedUsableModels,
      );
    }
    const discoveredDefault = this.codec.decode(
      'agent.v1.GetDefaultModelForCliResponse',
      defaultResponse,
    ).model?.modelId;
    for (const defaultModel of [discoveredDefault, this.config.defaultModel]) {
      if (typeof defaultModel !== 'string' || !defaultModel) continue;
      const existing = models.findIndex((model) => model.id === defaultModel);
      if (existing >= 0) models.unshift(...models.splice(existing, 1));
      else {
        models.unshift({
          id: defaultModel,
          object: 'model',
          created: 1_700_000_000,
          owned_by: 'cursor',
        });
      }
    }
    this.modelCache = { models, expiresAt: Date.now() + MODEL_TTL_MS };
    return models;
  }

  private cacheAgentUrl(response: Buffer): string {
    const override = this.environment.CURSOR_BRIDGE_CURSOR_AGENT_ENDPOINT?.replace(/\/$/, '');
    const decoded = this.codec.decode('aiserver.v1.GetServerConfigResponse', response);
    const discovered = decoded.agentUrlConfig?.agentnUrl || decoded.agentUrlConfig?.agentUrl;
    const url = override || discovered;
    if (typeof url !== 'string' || !url.startsWith('https://')) {
      throw new CursorBackendError('Cursor server discovery did not return agentnUrl');
    }
    this.discoveryCache = { url, expiresAt: Date.now() + DISCOVERY_TTL_MS };
    return url;
  }

  private async withCredential<T>(
    operation: (credential: CursorApiCredential, accessToken: string) => Promise<T>,
  ): Promise<T> {
    return this.credentialRouter.route(async (credential) =>
      operation(credential, await this.auth.getToken(credential)),
    );
  }

  private async agentUrl(accessToken: string): Promise<string> {
    if (this.discoveryCache && this.discoveryCache.expiresAt > Date.now()) {
      return this.discoveryCache.url;
    }
    if (!this.discoveryRefresh) {
      this.discoveryRefresh = (async () => {
        const response = await this.transport.unary(
          '/aiserver.v1.ServerConfigService/GetServerConfig',
          this.codec.encode('aiserver.v1.GetServerConfigRequest'),
          undefined,
          false,
          accessToken,
        );
        return this.cacheAgentUrl(response);
      })().finally(() => {
        this.discoveryRefresh = undefined;
      });
    }
    return this.discoveryRefresh;
  }

  private async run(
    request: ChatCompletionRequest,
    signal?: AbortSignal,
    emit?: (event: CompletionStreamEvent) => void,
  ): Promise<RunOutcome> {
    return this.withCredential(async (_credential, accessToken) =>
      this.runWithCredential(request, accessToken, signal, emit),
    );
  }

  private async runWithCredential(
    request: ChatCompletionRequest,
    accessToken: string,
    signal?: AbortSignal,
    emit?: (event: CompletionStreamEvent) => void,
  ): Promise<RunOutcome> {
    if (signal?.aborted) throw new CursorCommandAbortedError();
    const requestId = randomUUID();
    const stream = await this.transport.openRun(
      await this.agentUrl(accessToken),
      requestId,
      accessToken,
    );
    this.activeStreams.add(stream);
    const decoder = new ConnectFrameDecoder();
    const blobs = new Map<string, Buffer>();
    const calls: ToolCall[] = [];
    let text = '';
    let usage: CompletionUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    let outputBytes = 0;
    const maxOutputBytes = boundedInteger(
      this.environment.CURSOR_BRIDGE_MAX_OUTPUT_BYTES,
      DEFAULT_MAX_OUTPUT_BYTES,
    );
    const timeoutMs = boundedInteger(
      this.environment.CURSOR_BRIDGE_CURSOR_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
    );

    return new Promise<RunOutcome>((resolve, reject) => {
      let settled = false;
      const announcedToolCallIds = new Set<string>();
      const cleanup = () => {
        this.intervals.clearInterval(heartbeat);
        this.timers.clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        this.activeStreams.delete(stream);
      };
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (!stream.destroyed) stream.close();
        if (error) reject(error);
        else resolve({ text, toolCalls: enforceNativeToolChoice(calls, request), usage });
      };
      const onAbort = () => {
        const error = new CursorCommandAbortedError();
        stream.destroy(error);
        finish(error);
      };
      const writeMessage = (message: Record<string, unknown>, compressed?: boolean) => {
        if (settled || stream.destroyed || stream.writableEnded) return;
        const payload = this.codec.encode('agent.v1.AgentClientMessage', message);
        stream.write(
          encodeConnectFrame(payload, { compressed: compressed ?? payload.length > 512 }),
        );
      };
      const sendExec = (
        exec: Record<string, any>,
        messageCase: string,
        value: Record<string, unknown>,
        options: { compressed?: boolean; localExecutionTimeMs?: number } = {},
      ) => {
        writeMessage(
          {
            message: {
              case: 'execClientMessage',
              value: {
                id: exec.id,
                execId: exec.execId,
                message: { case: messageCase, value },
                localExecutionTimeMs: options.localExecutionTimeMs,
              },
            },
          },
          options.compressed ?? false,
        );
      };
      const finishToolBatchIfComplete = () => {
        if (
          !nativeToolBatchComplete(
            announcedToolCallIds,
            calls,
            request.parallel_tool_calls !== false,
          )
        ) {
          return;
        }
        finish();
        if (!stream.destroyed) stream.destroy();
      };
      const handleExec = (exec: Record<string, any>) => {
        const message = exec.message as { case?: string; value?: Record<string, any> } | undefined;
        const execCase = message?.case;
        if (!execCase) return;
        if (execCase === 'requestContextArgs') {
          sendExec(exec, 'requestContextResult', requestContextResult(request), {
            compressed: true,
            localExecutionTimeMs: 1,
          });
          return;
        }
        if (execCase === 'mcpArgs') {
          calls.push(mcpArgsToToolCall(message.value ?? {}));
          finishToolBatchIfComplete();
          return;
        }
        if (execCase === 'mcpAllowlistPrecheckArgs') {
          sendExec(exec, 'mcpAllowlistPrecheckResult', { allowlisted: true });
          return;
        }
        if (execCase === 'mcpStateExecArgs') {
          sendExec(exec, 'mcpStateExecResult', {
            result: {
              case: 'success',
              value: {
                servers: [
                  {
                    serverName: 'bridge',
                    serverIdentifier: 'bridge',
                    tools: (request.tools ?? []).map(nativeToolDefinition),
                    status: 'connected',
                  },
                ],
              },
            },
          });
          return;
        }
        if (execCase === 'listMcpResourcesExecArgs') {
          sendExec(exec, 'listMcpResourcesExecResult', {
            result: { case: 'success', value: { resources: [] } },
          });
          return;
        }
        const resultCase =
          execCase === 'shellStreamArgs'
            ? 'shellResult'
            : execCase.replace(/Args$/, 'Result').replace(/Request$/, 'Response');
        const resultField = this.codec.descriptors.messages[
          'agent.v1.ExecClientMessage'
        ]?.fields.find((field) => field.localName === resultCase);
        if (!resultField?.message) {
          finish(new CursorBackendError(`Cannot answer Cursor exec message ${execCase}`));
          return;
        }
        const resultDescriptor = this.codec.descriptors.messages[resultField.message];
        const failureField = resultDescriptor?.fields.find((field) =>
          ['rejected', 'error', 'permissionDenied', 'failure'].includes(field.localName),
        );
        if (!failureField?.message) {
          sendExec(exec, resultCase, {});
          return;
        }
        const rejectionMessage = 'Tool execution is delegated to the OpenAI client';
        const args = message.value ?? {};
        const failureValue = Object.fromEntries(
          (this.codec.descriptors.messages[failureField.message]?.fields ?? [])
            .filter((field) => !field.repeated && field.kind !== 'map')
            .map((field) => {
              if (field.kind === 'message') return [field.localName, {}];
              if (field.scalar === 9) {
                const fromArgs = args[field.localName];
                return [
                  field.localName,
                  typeof fromArgs === 'string'
                    ? fromArgs
                    : ['reason', 'error'].includes(field.localName)
                      ? rejectionMessage
                      : '',
                ];
              }
              if (field.scalar === 12) return [field.localName, Buffer.alloc(0)];
              if (field.scalar === 8) return [field.localName, false];
              return [field.localName, 0];
            }),
        );
        const rejection = failureField.oneof
          ? { [failureField.oneof]: { case: failureField.localName, value: failureValue } }
          : { [failureField.localName]: failureValue };
        sendExec(exec, resultCase, rejection);
      };
      const handleKv = (kv: Record<string, any>) => {
        const message = kv.message as { case?: string; value?: Record<string, any> } | undefined;
        if (message?.case === 'setBlobArgs') {
          const id = Buffer.from(message.value?.blobId ?? []).toString('hex');
          blobs.set(id, Buffer.from(message.value?.blobData ?? []));
          writeMessage({
            message: {
              case: 'kvClientMessage',
              value: { id: kv.id, message: { case: 'setBlobResult', value: {} } },
            },
          });
          return;
        }
        if (message?.case === 'getBlobArgs') {
          const id = Buffer.from(message.value?.blobId ?? []).toString('hex');
          const blobData = blobs.get(id);
          writeMessage({
            message: {
              case: 'kvClientMessage',
              value: {
                id: kv.id,
                message: { case: 'getBlobResult', value: blobData ? { blobData } : {} },
              },
            },
          });
          return;
        }
        finish(
          new CursorBackendError(`Cannot answer Cursor KV message ${message?.case ?? 'unknown'}`),
        );
      };
      const handleServerMessage = (payload: Buffer) => {
        const server = this.codec.decode('agent.v1.AgentServerMessage', payload);
        const message = server.message as
          | { case?: string; value?: Record<string, any> }
          | undefined;
        if (message?.case === 'execServerMessage') return handleExec(message.value ?? {});
        if (message?.case === 'kvServerMessage') return handleKv(message.value ?? {});
        if (message?.case !== 'interactionUpdate') return;
        const update = message.value?.message as
          | { case?: string; value?: Record<string, any> }
          | undefined;
        if (update?.case === 'textDelta') {
          const delta = String(update.value?.text ?? '');
          text += delta;
          if (delta) emit?.({ type: 'content', text: delta });
        } else if (update?.case === 'thinkingDelta') {
          const delta = String(update.value?.text ?? '');
          if (delta) emit?.({ type: 'thinking', text: delta });
        } else if (update?.case === 'partialToolCall' || update?.case === 'toolCallStarted') {
          const callId = String(update.value?.callId ?? '');
          if (callId) announcedToolCallIds.add(callId);
          finishToolBatchIfComplete();
        } else if (update?.case === 'turnEnded') {
          usage = usageFromTurnEnded(update.value ?? {});
        }
      };

      const heartbeat = this.intervals.setInterval(() => writeMessage(heartbeatMessage()), 5_000);
      const timeout = this.timers.setTimeout(() => {
        const error = new CursorBackendError(`Cursor API run timed out after ${timeoutMs}ms`);
        stream.destroy(error);
        finish(error);
      }, timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      stream.on('response', (headers: Record<string, unknown>) => {
        const status = Number(headers[':status']);
        if (status !== 200)
          finish(new CursorApiHttpError(status, `Cursor Agent Run failed with HTTP ${status}`));
      });
      stream.on('data', (chunk: Buffer) => {
        if (settled) return;
        outputBytes += chunk.length;
        if (outputBytes > maxOutputBytes) {
          const error = new CursorBackendError('output limit exceeded');
          stream.destroy(error);
          finish(error);
          return;
        }
        try {
          for (const frame of decoder.push(chunk)) {
            if (frame.trailer) finish();
            else if (frame.payload) handleServerMessage(frame.payload);
          }
        } catch (error) {
          stream.destroy(error as Error);
          finish(error);
        }
      });
      stream.once('error', (error: Error) => finish(error));
      stream.once('close', () => {
        if (!settled)
          finish(new CursorBackendError('Cursor Agent Run stream closed without a trailer'));
      });
      writeMessage(runRequestMessage(request, requestId, this.requestedModels), false);
      if (signal?.aborted) onAbort();
    });
  }
}

export function createCursorApiBackend(
  config: BridgeConfig,
  dependencies: CursorApiBackendDependencies = {},
): CursorBackend {
  return new CursorApiBackend(config, dependencies);
}
