import { parseCursorContextParameter } from '../../model-context.js';
import type { BridgeModel } from '../types.js';
import { CursorBackendError } from '../cursor-cli.js';
import { awaitWithAbort } from './auth.js';
import type { CursorApiCredential } from './credentials.js';
import { resolveModelVariant, type ResolvedModelVariant } from './max-mode-policy.js';
import { mapMaxModeModels, mapRequestedModels, mapUsableModels } from './requested-models.js';
import type { CursorApiRuntime } from './runtime.js';
import { unifiedModelList } from './unified-models.js';

export class CursorDiscoveryInvalidatedError extends CursorBackendError {
  readonly name = 'CursorDiscoveryInvalidatedError';
  constructor(
    readonly credentialId: string,
    readonly generation: number,
  ) {
    super('Cursor credential discovery was invalidated');
  }
}

/** Maps never escape this object; all returned parameter values are deeply frozen. */
export class DiscoveryModels {
  readonly expiresAt = Date.now() + 60_000;
  private readonly catalogue;
  private readonly usable;
  private readonly defaults;

  constructor(runtime: CursorApiRuntime, responses: readonly [Buffer, Buffer, Buffer]) {
    const [availableResponse, usableResponse, defaultResponse] = responses;
    const available = runtime.codec.decode(
      'aiserver.v1.AvailableModelsResponse',
      availableResponse,
    );
    const usable = runtime.codec.decode('agent.v1.GetUsableModelsResponse', usableResponse);
    const discovered = runtime.codec.decode(
      'agent.v1.GetDefaultModelForCliResponse',
      defaultResponse,
    ).model?.modelId;
    this.catalogue = {
      standard: mapRequestedModels(available, usable),
      max: mapMaxModeModels(available),
    };
    for (const models of [this.catalogue.standard, this.catalogue.max]) {
      for (const model of models.values()) {
        for (const parameter of model.parameters) Object.freeze(parameter);
        Object.freeze(model.parameters);
        Object.freeze(model);
      }
    }
    this.usable = mapUsableModels(usable);
    this.defaults = [discovered, runtime.config.defaultModel];
  }

  resolve(
    model: string,
    effort: string | undefined,
    maxMode: boolean,
  ): ResolvedModelVariant | undefined {
    const resolved = resolveModelVariant(this.catalogue, { model, effort, maxMode });
    return resolved && Object.freeze(resolved);
  }

  standardModels() {
    return new Map(this.catalogue.standard);
  }
  maxModels() {
    return new Map(this.catalogue.max);
  }

  list(maxMode: boolean): BridgeModel[] {
    const models = unifiedModelList(this.usable, (id) => {
      const resolved = this.resolve(id, undefined, maxMode);
      if (!resolved) return undefined;
      const context = resolved.model.parameters.find((parameter) => parameter.id === 'context');
      const contextWindow = context ? parseCursorContextParameter(context.value) : undefined;
      return {
        isMaxMode: resolved.isMaxMode,
        ...(contextWindow === undefined ? {} : { contextWindow }),
      };
    });
    for (const defaultModel of this.defaults) {
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
    return models;
  }
}

class DiscoveryCache<T> {
  value?: { readonly data: T; readonly expiresAt: number };
  private refresh?: Promise<T>;

  async get(slot: DiscoverySlot, load: () => Promise<T>, ttlMs: number): Promise<T> {
    slot.assertCurrent();
    if (this.value && this.value.expiresAt > Date.now()) return this.value.data;
    if (!this.refresh) {
      const refresh = awaitWithAbort(load(), slot.controller.signal)
        .then((data) => {
          slot.assertCurrent();
          this.value = { data, expiresAt: Date.now() + ttlMs };
          return data;
        })
        .finally(() => {
          if (this.refresh === refresh) this.refresh = undefined;
        });
      this.refresh = refresh;
    }
    return this.refresh;
  }
}

/** One credential configuration generation owns every cache and in-flight operation. */
export class DiscoverySlot {
  readonly controller = new AbortController();
  readonly endpoints = new DiscoveryCache<string>();
  readonly catalogues = new DiscoveryCache<DiscoveryModels>();
  startup?: Promise<void>;

  constructor(
    private readonly runtime: CursorApiRuntime,
    readonly credential: CursorApiCredential,
    readonly generation: number,
  ) {}

  assertCurrent(): void {
    this.controller.signal.throwIfAborted();
    const current = this.runtime.credentialRouter
      .credentials()
      .find((candidate) => candidate.id === this.credential.id);
    if (!current?.enabled || current.apiKey !== this.credential.apiKey) {
      throw new CursorDiscoveryInvalidatedError(this.credential.id, this.generation);
    }
  }

  async endpoint(accessToken: string): Promise<string> {
    await this.startup;
    return this.endpoints.get(
      this,
      async () =>
        decodeDiscoveryEndpoint(
          this.runtime,
          await this.unary(
            '/aiserver.v1.ServerConfigService/GetServerConfig',
            'aiserver.v1.GetServerConfigRequest',
            accessToken,
          ),
        ),
      3_600_000,
    );
  }

  async models(accessToken: string): Promise<DiscoveryModels> {
    await this.startup;
    return this.catalogues.get(
      this,
      async () =>
        new DiscoveryModels(
          this.runtime,
          await Promise.all([
            this.unary(
              '/aiserver.v1.AiService/AvailableModels',
              'aiserver.v1.AvailableModelsRequest',
              accessToken,
            ),
            this.unary(
              '/aiserver.v1.AiService/GetUsableModels',
              'agent.v1.GetUsableModelsRequest',
              accessToken,
            ),
            this.unary(
              '/aiserver.v1.AiService/GetDefaultModelForCli',
              'agent.v1.GetDefaultModelForCliRequest',
              accessToken,
            ),
          ]),
        ),
      60_000,
    );
  }

  private unary(path: string, type: string, accessToken: string): Promise<Buffer> {
    this.assertCurrent();
    return this.runtime.transport.unary(
      path,
      this.runtime.codec.encode(
        type,
        type === 'aiserver.v1.AvailableModelsRequest'
          ? { useModelParameters: true, doNotUseMarkdown: true }
          : undefined,
      ),
      this.controller.signal,
      false,
      accessToken,
    );
  }
}

export function decodeDiscoveryEndpoint(runtime: CursorApiRuntime, response: Buffer): string {
  const override = runtime.environment.CURSOR_BRIDGE_CURSOR_AGENT_ENDPOINT?.replace(/\/$/, '');
  const decoded = runtime.codec.decode('aiserver.v1.GetServerConfigResponse', response);
  const url = override || decoded.agentUrlConfig?.agentnUrl || decoded.agentUrlConfig?.agentUrl;
  if (typeof url !== 'string' || !url.startsWith('https://')) {
    throw new CursorBackendError('Cursor server discovery did not return agentnUrl');
  }
  return url;
}
