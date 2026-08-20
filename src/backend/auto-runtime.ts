import type {
  CursorApiCredential,
  CursorApiCredentialStateView,
} from './cursor-api/credentials.js';
import { cursorRetryFailureKind } from './cursor-api/index.js';
import { CursorApiHttpError } from './cursor-api/transport.js';
import type {
  BackendHealth,
  BridgeModel,
  ChatCompletionRequest,
  CompletionResult,
  CompletionStreamEvent,
  CursorBackend,
} from './types.js';
import { requestTrace, traceBackend, traceBackendFlip, type RequestTrace } from '../trace.js';

export interface ProbeableCursorApiBackend extends CursorBackend {
  initialize(timeoutMs?: number): Promise<void>;
  probe(timeoutMs?: number): Promise<void>;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failureKind(error: unknown): 'ordinary' | 'auth' | 'protocol' | 'transport' {
  if (error instanceof CursorApiHttpError) {
    if (error.status === 401 || error.status === 403) return 'auth';
    if (error.status === 429 || (error.status >= 400 && error.status < 500)) return 'ordinary';
    return 'transport';
  }
  const message = errorText(error);
  if (/outdated.?client|client.+out.?of.?date|unsupported.+protocol|unimplemented/i.test(message)) {
    return 'protocol';
  }
  if (/\b(?:401|403)\b|unauthenticated|authentication rejected|invalid token/i.test(message)) {
    return 'auth';
  }
  const code =
    error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
  if (
    cursorRetryFailureKind(error) === 'transport' ||
    /ECONN|ETIMEDOUT|EPIPE|ENET|EHOST|ENOTFOUND|stream closed|socket|transport|timed out|truncated connect|invalid gzip/i.test(
      `${code ?? ''} ${message}`,
    )
  ) {
    return 'transport';
  }
  return 'ordinary';
}

export type AutoCursorBackendOptions = {
  readonly now: () => number;
  readonly warn: (message: string) => void;
  readonly cooldownMs: number;
  readonly fatalThreshold: number;
  readonly probeTimeoutMs: number;
  readonly initial: 'cursor-api' | 'cursor-cli';
  readonly initialReason?: string;
};

export class AutoCursorBackend implements CursorBackend {
  readonly type = 'auto';
  private active: CursorBackend;
  private consecutiveFatal = 0;
  private cooldownUntil?: number;
  private lastFlipReason?: string;
  private reprobe?: Promise<void>;

  constructor(
    private readonly api: ProbeableCursorApiBackend,
    private readonly cli: CursorBackend | undefined,
    private readonly options: AutoCursorBackendOptions,
  ) {
    if (options.initial === 'cursor-api') {
      this.active = api;
    } else {
      if (!cli) throw new Error('cursor-cli cannot be active without an available fallback binary');
      this.active = cli;
    }
    this.lastFlipReason = options.initialReason;
  }

  private async backendForRequest(trace?: RequestTrace): Promise<CursorBackend> {
    if (!this.cli || this.active !== this.cli || this.cooldownUntil === undefined) {
      return this.active;
    }
    if (this.options.now() < this.cooldownUntil) return this.cli;
    if (!this.reprobe) {
      this.reprobe = this.api
        .probe(this.options.probeTimeoutMs)
        .then(() => {
          this.active = this.api;
          this.consecutiveFatal = 0;
          this.cooldownUntil = undefined;
          this.lastFlipReason = 'cursor-api probe recovered';
          traceBackendFlip(trace, this.api.type);
        })
        .catch((error: unknown) => {
          this.cooldownUntil = this.options.now() + this.options.cooldownMs;
          this.lastFlipReason = `cursor-api re-probe failed: ${errorText(error)}`;
        })
        .finally(() => {
          this.reprobe = undefined;
        });
    }
    await this.reprobe;
    return this.active;
  }

  private recordResult(backend: CursorBackend, error?: unknown, trace?: RequestTrace): void {
    if (backend !== this.api) return;
    if (error === undefined) {
      this.consecutiveFatal = 0;
      return;
    }
    const kind = failureKind(error);
    if (kind === 'ordinary') {
      this.consecutiveFatal = 0;
      return;
    }
    this.consecutiveFatal =
      kind === 'transport' ? this.consecutiveFatal + 1 : this.options.fatalThreshold;
    if (this.consecutiveFatal < this.options.fatalThreshold || !this.cli) return;
    this.active = this.cli;
    traceBackendFlip(trace, this.cli.type);
    this.cooldownUntil = this.options.now() + this.options.cooldownMs;
    this.lastFlipReason = `${kind}: ${errorText(error)}`;
    this.options.warn(
      `cursor-api became unusable (${this.lastFlipReason}); falling back to cursor-cli until ${new Date(this.cooldownUntil).toISOString()}`,
    );
  }

  async health(): Promise<BackendHealth> {
    const active = await this.backendForRequest();
    const health = await active.health();
    return {
      ...health,
      type: this.type,
      configuredMode: 'auto',
      activeBackend: active.type,
      fallbackAvailable: Boolean(this.cli),
      flipState: {
        consecutiveFatal: this.consecutiveFatal,
        cooldownUntil: this.cooldownUntil,
        reason: this.lastFlipReason,
      },
    };
  }

  async listModels(): Promise<BridgeModel[]> {
    const backend = await this.backendForRequest();
    try {
      const result = await backend.listModels();
      this.recordResult(backend);
      return result;
    } catch (error) {
      this.recordResult(backend, error);
      throw error;
    }
  }

  async complete(request: ChatCompletionRequest, signal?: AbortSignal): Promise<CompletionResult> {
    const trace = requestTrace(request);
    const backend = await this.backendForRequest(trace);
    traceBackend(trace, backend.type);
    try {
      const result = await backend.complete(request, signal);
      this.recordResult(backend, undefined, trace);
      return result;
    } catch (error) {
      this.recordResult(backend, error, trace);
      throw error;
    }
  }

  async *completeStream(
    request: ChatCompletionRequest,
    signal?: AbortSignal,
  ): AsyncIterable<CompletionStreamEvent> {
    const trace = requestTrace(request);
    const backend = await this.backendForRequest(trace);
    traceBackend(trace, backend.type);
    try {
      for await (const event of backend.completeStream(request, signal)) yield event;
      this.recordResult(backend, undefined, trace);
    } catch (error) {
      this.recordResult(backend, error, trace);
      throw error;
    }
  }

  credentialStates(): CursorApiCredentialStateView[] {
    return this.api.credentialStates?.() ?? [];
  }

  updateCredentials(credentials: CursorApiCredential[]): void {
    this.api.updateCredentials?.(credentials);
  }

  async shutdown(): Promise<void> {
    await Promise.all([this.api.shutdown?.(), this.cli?.shutdown?.()]);
  }
}
