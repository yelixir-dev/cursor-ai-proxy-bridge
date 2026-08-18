import { accessSync, constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import type { BridgeConfig } from '../config.js';
import { createCursorCliBackend } from './cursor-cli.js';
import {
  CursorApiBackend,
  cursorRetryFailureKind,
  type CursorApiBackendDependencies,
} from './cursor-api/index.js';
import { CursorApiHttpError } from './cursor-api/transport.js';
import type {
  CursorApiCredential,
  CursorApiCredentialStateView,
} from './cursor-api/credentials.js';
import type {
  BackendHealth,
  BridgeModel,
  ChatCompletionRequest,
  CompletionResult,
  CompletionStreamEvent,
  CursorBackend,
} from './types.js';

const DEFAULT_COOLDOWN_MS = 60_000;
const DEFAULT_FATAL_THRESHOLD = 3;
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

export interface ProbeableCursorApiBackend extends CursorBackend {
  initialize(timeoutMs?: number): Promise<void>;
  probe(timeoutMs?: number): Promise<void>;
}

export interface BackendSelectionDependencies {
  environment?: NodeJS.ProcessEnv;
  apiDependencies?: CursorApiBackendDependencies;
  createApi?: () => ProbeableCursorApiBackend;
  createCli?: (binary: string) => CursorBackend;
  findCliBinary?: (environment: NodeJS.ProcessEnv) => string | undefined;
  now?: () => number;
  warn?: (message: string) => void;
  cooldownMs?: number;
  fatalThreshold?: number;
  probeTimeoutMs?: number;
}

function positiveInteger(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findCursorCliBinary(
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const configured = environment.CURSOR_BRIDGE_CURSOR_BIN?.trim();
  const names = configured ? [configured] : ['cursor-agent', 'agent', 'cursor'];
  const pathEntries = (environment.PATH ?? '').split(delimiter).filter(Boolean);
  for (const name of names) {
    if (isAbsolute(name) || name.includes('/')) {
      if (executable(name)) return name;
      continue;
    }
    for (const entry of pathEntries) {
      const candidate = join(entry, name);
      if (executable(candidate)) return candidate;
    }
  }
  return undefined;
}

function errorText(error: unknown): string {
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
    private readonly options: {
      now: () => number;
      warn: (message: string) => void;
      cooldownMs: number;
      fatalThreshold: number;
      probeTimeoutMs: number;
      initial: 'cursor-api' | 'cursor-cli';
      initialReason?: string;
    },
  ) {
    if (options.initial === 'cursor-cli' && !cli) {
      throw new Error('cursor-cli cannot be active without an available fallback binary');
    }
    this.active = options.initial === 'cursor-api' ? api : cli!;
    this.lastFlipReason = options.initialReason;
  }

  private async backendForRequest(): Promise<CursorBackend> {
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

  private recordResult(backend: CursorBackend, error?: unknown): void {
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
    const backend = await this.backendForRequest();
    try {
      const result = await backend.complete(request, signal);
      this.recordResult(backend);
      return result;
    } catch (error) {
      this.recordResult(backend, error);
      throw error;
    }
  }

  async *completeStream(
    request: ChatCompletionRequest,
    signal?: AbortSignal,
  ): AsyncIterable<CompletionStreamEvent> {
    const backend = await this.backendForRequest();
    try {
      for await (const event of backend.completeStream(request, signal)) yield event;
      this.recordResult(backend);
    } catch (error) {
      this.recordResult(backend, error);
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

export async function createConfiguredBackend(
  config: BridgeConfig,
  dependencies: BackendSelectionDependencies = {},
): Promise<CursorBackend> {
  if (config.backend === 'mock') {
    throw new Error('mock backend must be created by the application entry point');
  }
  const environment = dependencies.environment ?? process.env;
  const createApi =
    dependencies.createApi ??
    (() => new CursorApiBackend(config, { ...dependencies.apiDependencies, environment }));
  const findBinary = dependencies.findCliBinary ?? findCursorCliBinary;
  const createCli =
    dependencies.createCli ??
    ((binary: string) =>
      createCursorCliBackend(config, {
        environment: { ...environment, CURSOR_BRIDGE_CURSOR_BIN: binary },
      }));
  const probeTimeoutMs =
    dependencies.probeTimeoutMs ??
    positiveInteger(environment.CURSOR_BRIDGE_AUTO_PROBE_TIMEOUT_MS, DEFAULT_PROBE_TIMEOUT_MS);

  if (config.backend === 'cursor-api') {
    const api = createApi();
    await api.initialize(probeTimeoutMs);
    return api;
  }
  if (config.backend === 'cursor-cli') {
    const binary = findBinary(environment);
    if (!binary) {
      throw new Error(
        'Forced cursor-cli backend is unavailable: set CURSOR_BRIDGE_CURSOR_BIN to an executable cursor-agent, agent, or cursor binary.',
      );
    }
    return createCli(binary);
  }

  let api: ProbeableCursorApiBackend | undefined;
  let apiReady = false;
  let apiFailure = 'not attempted';
  try {
    api = createApi();
    await api.initialize(probeTimeoutMs);
    apiReady = true;
  } catch (error) {
    apiFailure = errorText(error);
  }
  const binary = findBinary(environment);
  if (apiReady && api) {
    return new AutoCursorBackend(api, binary ? createCli(binary) : undefined, {
      now: dependencies.now ?? Date.now,
      warn: dependencies.warn ?? console.warn,
      cooldownMs:
        dependencies.cooldownMs ??
        positiveInteger(environment.CURSOR_BRIDGE_AUTO_COOLDOWN_MS, DEFAULT_COOLDOWN_MS),
      fatalThreshold:
        dependencies.fatalThreshold ??
        positiveInteger(environment.CURSOR_BRIDGE_AUTO_FATAL_THRESHOLD, DEFAULT_FATAL_THRESHOLD),
      probeTimeoutMs,
      initial: 'cursor-api',
    });
  }
  if (binary) {
    const unavailableApi: ProbeableCursorApiBackend =
      api ??
      ({
        type: 'cursor-api',
        initialize: async () => Promise.reject(new Error(apiFailure)),
        probe: async () => Promise.reject(new Error(apiFailure)),
        health: async () => ({
          ok: false,
          type: 'cursor-api',
          authConfigured: false,
          detail: apiFailure,
        }),
        listModels: async () => Promise.reject(new Error(apiFailure)),
        complete: async () => Promise.reject(new Error(apiFailure)),
        completeStream: () => {
          const iterator: AsyncIterableIterator<CompletionStreamEvent> = {
            next: async () => Promise.reject(new Error(apiFailure)),
            [Symbol.asyncIterator]: () => iterator,
          };
          return iterator;
        },
      } satisfies ProbeableCursorApiBackend);
    return new AutoCursorBackend(unavailableApi, createCli(binary), {
      now: dependencies.now ?? Date.now,
      warn: dependencies.warn ?? console.warn,
      cooldownMs:
        dependencies.cooldownMs ??
        positiveInteger(environment.CURSOR_BRIDGE_AUTO_COOLDOWN_MS, DEFAULT_COOLDOWN_MS),
      fatalThreshold:
        dependencies.fatalThreshold ??
        positiveInteger(environment.CURSOR_BRIDGE_AUTO_FATAL_THRESHOLD, DEFAULT_FATAL_THRESHOLD),
      probeTimeoutMs,
      initial: 'cursor-cli',
      initialReason: `cursor-api startup probe failed: ${apiFailure}`,
    });
  }
  throw new Error(
    `No Cursor backend is usable. Tried cursor-api (${apiFailure}) and cursor-cli (no executable cursor-agent, agent, or cursor found; set CURSOR_BRIDGE_CURSOR_BIN).`,
  );
}
