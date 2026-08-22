import type { BackendHealth, BridgeModel } from '../types.js';
import { CursorBackendError } from '../cursor-cli.js';
import { awaitWithAbort } from './auth.js';
import { withCursorCredential } from './credential-route.js';
import { mapRequestedModels, mapUsableModels, type RequestedModel } from './requested-models.js';
import { resolveVariantSlug, unifiedModelList } from './unified-models.js';
import type { CursorApiRuntime } from './runtime.js';
import { CURSOR_API_STARTUP_SEQUENCE } from './startup-sequence.js';

const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const MODEL_TTL_MS = 60 * 1000;
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

export class CursorApiDiscovery {
  readonly requestedModels = new Map<string, RequestedModel>();
  private discoveryCache?: { readonly url: string; readonly expiresAt: number };
  private discoveryRefresh?: Promise<string>;
  private modelCache?: { readonly models: BridgeModel[]; readonly expiresAt: number };
  private modelRefresh?: Promise<BridgeModel[]>;
  private initialization?: Promise<void>;
  private initialized = false;

  constructor(private readonly runtime: CursorApiRuntime) {}

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
    await withCursorCredential(this.runtime, {
      operation: async (_credential, accessToken) => {
        const response = await this.runtime.transport.unary(
          '/aiserver.v1.ServerConfigService/GetServerConfig',
          this.runtime.codec.encode('aiserver.v1.GetServerConfigRequest'),
          AbortSignal.timeout(timeoutMs),
          false,
          accessToken,
        );
        this.cacheAgentUrl(response);
      },
    });
  }

  async health(): Promise<BackendHealth> {
    try {
      await withCursorCredential(this.runtime, {
        operation: async (_credential, accessToken) => this.agentUrl(accessToken),
      });
      return {
        ok: true,
        type: 'cursor-api',
        authConfigured: this.hasEnabledCredential(),
        detail: 'direct Cursor API available',
      };
    } catch (error) {
      return {
        ok: false,
        type: 'cursor-api',
        authConfigured: this.hasEnabledCredential(),
        detail: error instanceof Error ? error.message : 'direct Cursor API unavailable',
      };
    }
  }

  /** Resolves unified ids (plus reasoning_effort) or legacy slugs to a RequestedModel. */
  resolveRequestedModel(model: string, effort?: string): RequestedModel | undefined {
    const direct = this.requestedModels.get(model);
    if (direct) return direct;
    const slug = resolveVariantSlug(model, effort, this.requestedModels.keys());
    return slug ? this.requestedModels.get(slug) : undefined;
  }

  async listModels(): Promise<BridgeModel[]> {
    if (this.modelCache && this.modelCache.expiresAt > Date.now()) {
      return [...this.modelCache.models];
    }
    if (!this.modelRefresh) {
      this.modelRefresh = withCursorCredential(this.runtime, {
        operation: async (_credential, accessToken) => {
          const [modelsResponse, defaultResponse] = await Promise.all([
            this.runtime.transport.unary(
              '/aiserver.v1.AiService/GetUsableModels',
              this.runtime.codec.encode('agent.v1.GetUsableModelsRequest'),
              undefined,
              false,
              accessToken,
            ),
            this.runtime.transport.unary(
              '/aiserver.v1.AiService/GetDefaultModelForCli',
              this.runtime.codec.encode('agent.v1.GetDefaultModelForCliRequest'),
              undefined,
              false,
              accessToken,
            ),
          ]);
          return this.cacheModels(modelsResponse, defaultResponse);
        },
      }).finally(() => {
        this.modelRefresh = undefined;
      });
    }
    return [...(await this.modelRefresh)];
  }

  async agentUrl(accessToken: string, signal?: AbortSignal): Promise<string> {
    if (this.discoveryCache && this.discoveryCache.expiresAt > Date.now()) {
      return awaitWithAbort(Promise.resolve(this.discoveryCache.url), signal);
    }
    if (!this.discoveryRefresh) {
      this.discoveryRefresh = (async () => {
        const response = await this.runtime.transport.unary(
          '/aiserver.v1.ServerConfigService/GetServerConfig',
          this.runtime.codec.encode('aiserver.v1.GetServerConfigRequest'),
          undefined,
          false,
          accessToken,
        );
        return this.cacheAgentUrl(response);
      })().finally(() => {
        this.discoveryRefresh = undefined;
      });
    }
    return awaitWithAbort(this.discoveryRefresh, signal);
  }

  private async startup(timeoutMs: number): Promise<void> {
    await withCursorCredential(this.runtime, {
      operation: async (_credential, accessToken) => {
        const signal = AbortSignal.timeout(timeoutMs);
        const unary = (index: number, type: string, value?: Record<string, unknown>) =>
          this.runtime.transport.unary(
            CURSOR_API_STARTUP_SEQUENCE[index] ?? '',
            this.runtime.codec.encode(type, value),
            signal,
            index === 0,
            accessToken,
          );
        await unary(0, 'aiserver.v1.GetMeRequest');
        this.cacheAgentUrl(await unary(1, 'aiserver.v1.GetServerConfigRequest'));
        const available = await unary(2, 'aiserver.v1.AvailableModelsRequest', {
          useModelParameters: true,
          doNotUseMarkdown: true,
        });
        const usable = await unary(3, 'agent.v1.GetUsableModelsRequest');
        const defaultModel = await unary(4, 'agent.v1.GetDefaultModelForCliRequest');
        this.cacheModels(usable, defaultModel, available);
        await unary(5, 'aiserver.v1.GetMeRequest');
        this.cacheAgentUrl(await unary(6, 'aiserver.v1.GetServerConfigRequest'));
        const telemetry = this.runtime.transport.telemetry?.bind(this.runtime.transport);
        if (!telemetry) return;
        await telemetry(CURSOR_API_STARTUP_SEQUENCE[7], { logs: [] }, signal, accessToken);
        await telemetry(CURSOR_API_STARTUP_SEQUENCE[8], { events: [] }, signal, accessToken);
        await telemetry(CURSOR_API_STARTUP_SEQUENCE[9], { logs: [] }, signal, accessToken);
        await telemetry(CURSOR_API_STARTUP_SEQUENCE[10], { logs: [] }, signal, accessToken);
      },
    });
  }

  private cacheModels(
    modelsResponse: Buffer,
    defaultResponse: Buffer,
    availableResponse?: Buffer,
  ): BridgeModel[] {
    const usable = this.runtime.codec.decode('agent.v1.GetUsableModelsResponse', modelsResponse);
    const models = unifiedModelList(mapUsableModels(usable));
    if (availableResponse) {
      const available = this.runtime.codec.decode(
        'aiserver.v1.AvailableModelsResponse',
        availableResponse,
      );
      const mapped = mapRequestedModels(available, usable);
      this.requestedModels.clear();
      for (const [id, model] of mapped) this.requestedModels.set(id, model);
    }
    const discovered = this.runtime.codec.decode(
      'agent.v1.GetDefaultModelForCliResponse',
      defaultResponse,
    ).model?.modelId;
    for (const defaultModel of [discovered, this.runtime.config.defaultModel]) {
      if (typeof defaultModel !== 'string' || !defaultModel) continue;
      const existing = models.findIndex((model) => model.id === defaultModel);
      if (existing >= 0) models.unshift(...models.splice(existing, 1));
      else
        models.unshift({
          id: defaultModel,
          object: 'model',
          created: 1_700_000_000,
          owned_by: 'cursor',
        });
    }
    this.modelCache = { models, expiresAt: Date.now() + MODEL_TTL_MS };
    return models;
  }

  private cacheAgentUrl(response: Buffer): string {
    const override = this.runtime.environment.CURSOR_BRIDGE_CURSOR_AGENT_ENDPOINT?.replace(
      /\/$/,
      '',
    );
    const decoded = this.runtime.codec.decode('aiserver.v1.GetServerConfigResponse', response);
    const discovered = decoded.agentUrlConfig?.agentnUrl || decoded.agentUrlConfig?.agentUrl;
    const url = override || discovered;
    if (typeof url !== 'string' || !url.startsWith('https://')) {
      throw new CursorBackendError('Cursor server discovery did not return agentnUrl');
    }
    this.discoveryCache = { url, expiresAt: Date.now() + DISCOVERY_TTL_MS };
    return url;
  }

  private hasEnabledCredential(): boolean {
    return this.runtime.credentialRouter.credentials().some((credential) => credential.enabled);
  }
}
