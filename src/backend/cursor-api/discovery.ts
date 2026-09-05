import type { BackendHealth, BridgeModel, ModelVariantView } from '../types.js';
import { awaitWithAbort } from './auth.js';
import { withCursorCredential } from './credential-route.js';
import type { CursorApiCredential } from './credentials.js';
import {
  CursorDiscoveryInvalidatedError,
  decodeDiscoveryEndpoint,
  DiscoveryModels,
  DiscoverySlot,
} from './discovery-snapshot.js';
import type { ResolvedModelVariant } from './max-mode-policy.js';
import type { NativeAccountContext } from './native-context.js';
import type { RequestedModel } from './requested-models.js';
import type { CursorApiRuntime } from './runtime.js';
import { CURSOR_API_STARTUP_SEQUENCE } from './startup-sequence.js';
import type { SelectedSubagentModel } from './subagent-models.js';

export { CursorDiscoveryInvalidatedError } from './discovery-snapshot.js';

export interface PreparedCursorDiscovery {
  readonly credentialId: string;
  readonly generation: number;
  readonly agentUrl: string;
  readonly signal: AbortSignal;
  readonly maxModeEnabled: boolean;
  readonly selectedSubagentModels: readonly SelectedSubagentModel[];
  readonly nativeContext: NativeAccountContext;
  resolveVariant(model: string, effort?: string): ResolvedModelVariant | undefined;
  resolveRequestedModel(model: string, effort?: string): RequestedModel | undefined;
}

const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

interface AdvertisedDiscovery {
  readonly slot: DiscoverySlot;
  readonly models: DiscoveryModels;
}

export class CursorApiDiscovery {
  private maxMode: boolean;
  private readonly slots = new Map<string, DiscoverySlot>();
  private readonly generations = new Map<string, number>();
  private advertised?: AdvertisedDiscovery;
  private listing?: { slot?: DiscoverySlot; readonly promise: Promise<AdvertisedDiscovery> };
  private initialization?: Promise<void>;
  private initialized = false;

  constructor(private readonly runtime: CursorApiRuntime) {
    this.maxMode = runtime.config.maxModeDefault === true;
  }

  get maxModeEnabled(): boolean {
    return this.maxMode;
  }
  setMaxMode(enabled: boolean): void {
    this.maxMode = enabled;
  }

  /** Compatibility views of the last listing; inference must use prepare instead. */
  get requestedModels(): Map<string, RequestedModel> {
    return this.advertised?.models.standardModels() ?? new Map();
  }
  get maxModeModels(): Map<string, RequestedModel> {
    return this.advertised?.models.maxModels() ?? new Map();
  }

  async prepare(
    credential: CursorApiCredential,
    accessToken: string,
    signal?: AbortSignal,
  ): Promise<PreparedCursorDiscovery> {
    signal?.throwIfAborted();
    const maxModeEnabled = this.maxMode;
    const slot = this.slot(credential);
    const [agentUrl, models, nativeContext] = await awaitWithAbort(
      Promise.all([
        slot.endpoint(accessToken),
        slot.models(accessToken),
        slot.context(accessToken),
      ]),
      signal,
    );
    slot.assertCurrent();
    signal?.throwIfAborted();
    return Object.freeze({
      credentialId: credential.id,
      generation: slot.generation,
      agentUrl,
      signal: slot.controller.signal,
      maxModeEnabled,
      selectedSubagentModels: models.selectedSubagentModels,
      nativeContext,
      resolveVariant: (model: string, effort?: string) =>
        models.resolve(model, effort, maxModeEnabled),
      resolveRequestedModel: (model: string, effort?: string) =>
        models.resolve(model, effort, maxModeEnabled)?.model,
    });
  }

  invalidateCredentials(ids: Iterable<string>): void {
    for (const id of new Set(ids)) {
      const slot = this.slots.get(id);
      const generation = this.generations.get(id) ?? 0;
      this.generations.set(id, generation + 1);
      this.slots.delete(id);
      slot?.controller.abort(new CursorDiscoveryInvalidatedError(id, generation));
      if (this.advertised?.slot.credential.id === id) this.advertised = undefined;
      if (this.listing?.slot?.credential.id === id) this.listing = undefined;
    }
  }

  private slot(credential: CursorApiCredential): DiscoverySlot {
    const current = this.runtime.credentialRouter
      .credentials()
      .find((candidate) => candidate.id === credential.id);
    if (!current?.enabled || current.apiKey !== credential.apiKey) {
      throw new CursorDiscoveryInvalidatedError(
        credential.id,
        this.generations.get(credential.id) ?? 0,
      );
    }
    const previous = this.slots.get(credential.id);
    if (previous && previous.credential.apiKey !== credential.apiKey)
      this.invalidateCredentials([credential.id]);
    let slot = this.slots.get(credential.id);
    if (!slot) {
      slot = new DiscoverySlot(
        this.runtime,
        { ...credential },
        this.generations.get(credential.id) ?? 0,
      );
      this.slots.set(credential.id, slot);
    }
    slot.assertCurrent();
    return slot;
  }

  resolveVariant(model: string, effort?: string): ResolvedModelVariant | undefined {
    return this.advertised?.models.resolve(model, effort, this.maxMode);
  }
  resolveRequestedModel(model: string, effort?: string): RequestedModel | undefined {
    return this.resolveVariant(model, effort)?.model;
  }
  modelVariants(models: readonly BridgeModel[]): ModelVariantView[] {
    return models.flatMap((model) => {
      const resolved = this.resolveVariant(model.id);
      return resolved
        ? [
            {
              id: model.id,
              resolvedVariant: resolved.slug,
              isMaxMode: resolved.isMaxMode,
              ...(model.context_window === undefined
                ? {}
                : { contextWindow: model.context_window }),
            },
          ]
        : [];
    });
  }
  cachedModels(): BridgeModel[] {
    return this.advertised?.models.list(this.maxMode) ?? [];
  }

  async listModels(): Promise<BridgeModel[]> {
    if (this.advertised && this.advertised.models.expiresAt > Date.now()) {
      this.advertised.slot.assertCurrent();
      return this.cachedModels();
    }
    if (!this.listing) {
      const listing: { slot?: DiscoverySlot; readonly promise: Promise<AdvertisedDiscovery> } = {
        promise: withCursorCredential(this.runtime, {
          operation: async (credential, accessToken) => {
            const slot = this.slot(credential);
            listing.slot = slot;
            const models = await slot.models(accessToken);
            slot.assertCurrent();
            const advertised = { slot, models };
            this.advertised = advertised;
            return advertised;
          },
        }).finally(() => {
          if (this.listing === listing) this.listing = undefined;
        }),
      };
      this.listing = listing;
    }
    const advertised = await this.listing.promise;
    advertised.slot.assertCurrent();
    return advertised.models.list(this.maxMode);
  }

  async initialize(timeoutMs = DEFAULT_PROBE_TIMEOUT_MS): Promise<void> {
    if (this.initialized) return;
    if (!this.initialization) {
      this.initialization = withCursorCredential(this.runtime, {
        operation: async (credential, accessToken) => {
          const slot = this.slot(credential);
          const signal = AbortSignal.any([slot.controller.signal, AbortSignal.timeout(timeoutMs)]);
          const startup = awaitWithAbort(this.startup(slot, accessToken, signal), signal);
          slot.startup = startup;
          try {
            await startup;
          } finally {
            if (slot.startup === startup) slot.startup = undefined;
          }
        },
      })
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
      operation: async (credential, accessToken) => {
        const slot = this.slot(credential);
        const signal = AbortSignal.any([slot.controller.signal, AbortSignal.timeout(timeoutMs)]);
        const url = decodeDiscoveryEndpoint(
          this.runtime,
          await awaitWithAbort(
            this.runtime.transport.unary(
              '/aiserver.v1.ServerConfigService/GetServerConfig',
              this.runtime.codec.encode('aiserver.v1.GetServerConfigRequest'),
              signal,
              false,
              accessToken,
            ),
            signal,
          ),
        );
        slot.assertCurrent();
        slot.endpoints.value = { data: url, expiresAt: Date.now() + 3_600_000 };
      },
    });
  }

  async health(): Promise<BackendHealth> {
    const authConfigured = this.runtime.credentialRouter
      .credentials()
      .some((credential) => credential.enabled);
    try {
      await withCursorCredential(this.runtime, {
        operation: (credential, accessToken) => this.slot(credential).endpoint(accessToken),
      });
      return {
        ok: true,
        type: 'cursor-api',
        authConfigured,
        detail: 'direct Cursor API available',
      };
    } catch (error) {
      return {
        ok: false,
        type: 'cursor-api',
        authConfigured,
        detail: error instanceof Error ? error.message : 'direct Cursor API unavailable',
      };
    }
  }

  /** @deprecated Pass the selected credential to prepare; token-only callers cannot share caches. */
  async agentUrl(accessToken: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const response = await awaitWithAbort(
      this.runtime.transport.unary(
        '/aiserver.v1.ServerConfigService/GetServerConfig',
        this.runtime.codec.encode('aiserver.v1.GetServerConfigRequest'),
        signal,
        false,
        accessToken,
      ),
      signal,
    );
    return decodeDiscoveryEndpoint(this.runtime, response);
  }

  private async startup(
    slot: DiscoverySlot,
    accessToken: string,
    signal: AbortSignal,
  ): Promise<void> {
    const unary = (index: number, type: string, value?: Record<string, unknown>) => {
      slot.assertCurrent();
      signal.throwIfAborted();
      return awaitWithAbort(
        this.runtime.transport.unary(
          CURSOR_API_STARTUP_SEQUENCE[index] ?? '',
          this.runtime.codec.encode(type, value),
          signal,
          index === 0,
          accessToken,
        ),
        signal,
      );
    };
    await unary(0, 'aiserver.v1.GetMeRequest');
    decodeDiscoveryEndpoint(this.runtime, await unary(1, 'aiserver.v1.GetServerConfigRequest'));
    const available = await unary(2, 'aiserver.v1.AvailableModelsRequest', {
      useModelParameters: true,
      doNotUseMarkdown: true,
    });
    const usable = await unary(3, 'agent.v1.GetUsableModelsRequest');
    const defaultModel = await unary(4, 'agent.v1.GetDefaultModelForCliRequest');
    const models = new DiscoveryModels(this.runtime, [available, usable, defaultModel]);
    await unary(5, 'aiserver.v1.GetMeRequest');
    const url = decodeDiscoveryEndpoint(
      this.runtime,
      await unary(6, 'aiserver.v1.GetServerConfigRequest'),
    );
    const telemetry = this.runtime.transport.telemetry?.bind(this.runtime.transport);
    if (telemetry) {
      await awaitWithAbort(
        telemetry(CURSOR_API_STARTUP_SEQUENCE[7], { logs: [] }, signal, accessToken),
        signal,
      );
      await awaitWithAbort(
        telemetry(CURSOR_API_STARTUP_SEQUENCE[8], { events: [] }, signal, accessToken),
        signal,
      );
      await awaitWithAbort(
        telemetry(CURSOR_API_STARTUP_SEQUENCE[9], { logs: [] }, signal, accessToken),
        signal,
      );
      await awaitWithAbort(
        telemetry(CURSOR_API_STARTUP_SEQUENCE[10], { logs: [] }, signal, accessToken),
        signal,
      );
    }
    slot.assertCurrent();
    signal.throwIfAborted();
    slot.endpoints.value = { data: url, expiresAt: Date.now() + 3_600_000 };
    slot.catalogues.value = { data: models, expiresAt: models.expiresAt };
    this.advertised = { slot, models };
  }
}
