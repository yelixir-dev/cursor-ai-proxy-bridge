import type { BridgeConfig } from '../../config.js';
import { CursorAuthProvider } from './auth.js';
import { CursorCredentialRouter, cursorCredentialsFromConfig } from './credentials.js';
import { loadProtoDescriptors, ProtoCodec, type ProtoDescriptorSet } from './protobuf.js';
import {
  type CursorApiTransport,
  type CursorRunStream,
  NodeCursorApiTransport,
} from './transport.js';

export interface CursorApiBackendDependencies {
  readonly descriptors?: ProtoDescriptorSet;
  readonly descriptorPath?: string;
  readonly auth?: CursorAuthProvider;
  readonly transport?: CursorApiTransport;
  readonly environment?: NodeJS.ProcessEnv;
  readonly setInterval?: typeof globalThis.setInterval;
  readonly clearInterval?: typeof globalThis.clearInterval;
  readonly setTimeout?: typeof globalThis.setTimeout;
  readonly clearTimeout?: typeof globalThis.clearTimeout;
  readonly wait?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  readonly credentialRouter?: CursorCredentialRouter;
  readonly now?: () => number;
}

export interface CursorApiRuntime {
  readonly config: BridgeConfig;
  readonly codec: ProtoCodec;
  readonly auth: CursorAuthProvider;
  readonly transport: CursorApiTransport;
  readonly credentialRouter: CursorCredentialRouter;
  readonly environment: NodeJS.ProcessEnv;
  readonly activeStreams: Set<CursorRunStream>;
  readonly timers: {
    readonly setInterval: typeof globalThis.setInterval;
    readonly clearInterval: typeof globalThis.clearInterval;
    readonly setTimeout: typeof globalThis.setTimeout;
    readonly clearTimeout: typeof globalThis.clearTimeout;
  };
  readonly wait: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

export function boundedInteger(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function createCursorApiRuntime(
  config: BridgeConfig,
  dependencies: CursorApiBackendDependencies,
): CursorApiRuntime {
  const environment = dependencies.environment ?? process.env;
  const envDescriptorPath = environment.CURSOR_BRIDGE_CURSOR_API_DESCRIPTORS?.trim();
  const descriptors =
    dependencies.descriptors ??
    loadProtoDescriptors(
      dependencies.descriptorPath ?? (envDescriptorPath ? envDescriptorPath : undefined),
    );
  const codec = new ProtoCodec(descriptors);
  const auth =
    dependencies.auth ??
    new CursorAuthProvider({
      environment,
      apiEndpoint: environment.CURSOR_BRIDGE_CURSOR_API_ENDPOINT ?? environment.CURSOR_API_ENDPOINT,
    });
  const transport =
    dependencies.transport ??
    new NodeCursorApiTransport({
      auth,
      clientVersion: descriptors.clientVersion,
      apiEndpoint: environment.CURSOR_BRIDGE_CURSOR_API_ENDPOINT ?? environment.CURSOR_API_ENDPOINT,
      agentEndpoint: environment.CURSOR_BRIDGE_CURSOR_AGENT_ENDPOINT,
    });
  const timers = {
    setInterval: dependencies.setInterval ?? globalThis.setInterval,
    clearInterval: dependencies.clearInterval ?? globalThis.clearInterval,
    setTimeout: dependencies.setTimeout ?? globalThis.setTimeout,
    clearTimeout: dependencies.clearTimeout ?? globalThis.clearTimeout,
  };
  const wait =
    dependencies.wait ??
    ((delayMs: number, signal?: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        const onAbort = () => {
          timers.clearTimeout(timer);
          reject(signal?.reason);
        };
        const timer = timers.setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        }, delayMs);
        signal?.addEventListener('abort', onAbort, { once: true });
      }));
  return {
    config,
    codec,
    auth,
    transport,
    environment,
    timers,
    wait,
    activeStreams: new Set(),
    credentialRouter:
      dependencies.credentialRouter ??
      new CursorCredentialRouter({
        credentials:
          config.cursorApiCredentials ??
          cursorCredentialsFromConfig(environment, config.dashboardConfig?.credentials ?? []),
        cooldownMs: boundedInteger(environment.CURSOR_BRIDGE_CREDENTIAL_COOLDOWN_MS, 300_000),
        now: dependencies.now,
      }),
  };
}
