import type {
  BackendHealth,
  BridgeModel,
  ChatCompletionRequest,
  CompletionResult,
  CompletionStreamEvent,
  CursorBackend,
} from '../types.js';
import { CursorCommandAbortedError } from '../cursor-cli.js';
import type { BridgeConfig } from '../../config.js';
import { CursorApiCompletion } from './completion.js';
import type { CursorApiCredential, CursorApiCredentialStateView } from './credentials.js';
import { CursorApiDiscovery } from './discovery.js';
import {
  createCursorApiRuntime,
  type CursorApiBackendDependencies,
  type CursorApiRuntime,
} from './runtime.js';

export class CursorApiBackend implements CursorBackend {
  readonly type = 'cursor-api';
  private readonly runtime: CursorApiRuntime;
  private readonly discovery: CursorApiDiscovery;
  private readonly completion: CursorApiCompletion;

  constructor(config: BridgeConfig, dependencies: CursorApiBackendDependencies = {}) {
    this.runtime = createCursorApiRuntime(config, dependencies);
    this.discovery = new CursorApiDiscovery(this.runtime);
    this.completion = new CursorApiCompletion(this.runtime, this.discovery);
  }

  initialize(timeoutMs?: number): Promise<void> {
    return this.discovery.initialize(timeoutMs);
  }

  probe(timeoutMs?: number): Promise<void> {
    return this.discovery.probe(timeoutMs);
  }

  health(): Promise<BackendHealth> {
    return this.discovery.health();
  }

  credentialStates(): CursorApiCredentialStateView[] {
    return this.runtime.credentialRouter.snapshot();
  }

  updateCredentials(credentials: CursorApiCredential[]): void {
    this.runtime.auth.invalidate();
    this.runtime.credentialRouter.replaceCredentials(credentials);
  }

  listModels(): Promise<BridgeModel[]> {
    return this.discovery.listModels();
  }

  complete(request: ChatCompletionRequest, signal?: AbortSignal): Promise<CompletionResult> {
    return this.completion.complete(request, signal);
  }

  completeStream(
    request: ChatCompletionRequest,
    signal?: AbortSignal,
  ): AsyncIterable<CompletionStreamEvent> {
    return this.completion.completeStream(request, signal);
  }

  async shutdown(): Promise<void> {
    for (const stream of this.runtime.activeStreams) {
      stream.destroy(new CursorCommandAbortedError('cursor API backend shutting down'));
    }
    this.runtime.activeStreams.clear();
    await this.runtime.transport.shutdown?.();
  }
}

export function createCursorApiBackend(
  config: BridgeConfig,
  dependencies: CursorApiBackendDependencies = {},
): CursorBackend {
  return new CursorApiBackend(config, dependencies);
}
