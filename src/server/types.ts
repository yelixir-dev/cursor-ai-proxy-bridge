import type { FastifyInstance } from 'fastify';
import type { CursorBackend } from '../backend/types.js';
import type { BridgeConfig } from '../config.js';
import type { ModelPolicy } from '../model-policy.js';
import type { ServerTraceOptions } from '../trace.js';
import type { CompletionLimiter } from './lifecycle.js';
import type { BackendHealthCache } from './health.js';

export type BuildServerOptions = {
  readonly config: BridgeConfig;
  readonly backend: CursorBackend;
  readonly trace?: ServerTraceOptions;
};

export type ServerContext = {
  readonly app: FastifyInstance;
  readonly config: BridgeConfig;
  readonly backend: CursorBackend;
  readonly modelPolicy: ModelPolicy;
  readonly health: BackendHealthCache;
  readonly limiter: CompletionLimiter;
  readonly startedAt: number;
  readonly trace?: ServerTraceOptions;
};
