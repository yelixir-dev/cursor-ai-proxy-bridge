import { accessSync, constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import type { BridgeConfig } from '../config.js';
import { createCursorCliBackend } from './cursor-cli.js';
import { CursorApiBackend, type CursorApiBackendDependencies } from './cursor-api/index.js';
import { AutoCursorBackend, errorText, type ProbeableCursorApiBackend } from './auto-runtime.js';
import type { CompletionStreamEvent, CursorBackend } from './types.js';

const DEFAULT_COOLDOWN_MS = 60_000;
const DEFAULT_FATAL_THRESHOLD = 3;
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

export type BackendSelectionDependencies = {
  readonly environment?: NodeJS.ProcessEnv;
  readonly apiDependencies?: CursorApiBackendDependencies;
  readonly createApi?: () => ProbeableCursorApiBackend;
  readonly createCli?: (binary: string) => CursorBackend;
  readonly findCliBinary?: (environment: NodeJS.ProcessEnv) => string | undefined;
  readonly now?: () => number;
  readonly warn?: (message: string) => void;
  readonly cooldownMs?: number;
  readonly fatalThreshold?: number;
  readonly probeTimeoutMs?: number;
};

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
  const options = {
    now: dependencies.now ?? Date.now,
    warn: dependencies.warn ?? console.warn,
    cooldownMs:
      dependencies.cooldownMs ??
      positiveInteger(environment.CURSOR_BRIDGE_AUTO_COOLDOWN_MS, DEFAULT_COOLDOWN_MS),
    fatalThreshold:
      dependencies.fatalThreshold ??
      positiveInteger(environment.CURSOR_BRIDGE_AUTO_FATAL_THRESHOLD, DEFAULT_FATAL_THRESHOLD),
    probeTimeoutMs,
  };
  if (apiReady && api) {
    return new AutoCursorBackend(api, binary ? createCli(binary) : undefined, {
      ...options,
      initial: 'cursor-api',
    });
  }
  if (binary) {
    if (!api) {
      api = {
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
      };
    }
    return new AutoCursorBackend(api, createCli(binary), {
      ...options,
      initial: 'cursor-cli',
      initialReason: `cursor-api startup probe failed: ${apiFailure}`,
    });
  }
  throw new Error(
    `No Cursor backend is usable. Tried cursor-api (${apiFailure}) and cursor-cli (no executable cursor-agent, agent, or cursor found; set CURSOR_BRIDGE_CURSOR_BIN).`,
  );
}
