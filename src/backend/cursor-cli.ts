import type { BridgeConfig } from '../config.js';
import {
  cursorModel,
  cursorModelsArgs,
  MODEL_CACHE_TTL_MS,
  MODEL_DISCOVERY_TIMEOUT_MS,
  parseCursorModels,
  validCursorTimeoutMs,
} from './cursor-cli-command.js';
import {
  completeCursor,
  completeCursorStream,
  type CursorCliCompletionContext,
} from './cursor-cli-completion.js';
import {
  CursorChildRegistry,
  type CursorChildProcess,
  type CursorSpawn,
} from './cursor-cli-child.js';
import { defaultCursorModels } from './mock.js';
import { createCursorCommandRunner, type CursorCommandRunner } from './cursor-cli-process.js';
import type { BridgeModel, CursorBackend } from './types.js';

export { CursorBackendError, CursorCommandAbortedError } from './cursor-cli-errors.js';
export { promptFromMessages } from './cursor-cli-prompt.js';
export { CursorChildRegistry } from './cursor-cli-child.js';
export type { CursorChildProcess, CursorSpawn } from './cursor-cli-child.js';
export { childEnvironment } from './cursor-cli-environment.js';
export { createCursorCommandRunner } from './cursor-cli-process.js';
export type { CursorCommandRunner, CursorCommandRunnerOptions } from './cursor-cli-process.js';

export type CursorCliBackendDependencies = {
  readonly commandRunner?: CursorCommandRunner;
  readonly spawn?: CursorSpawn;
  readonly environment?: NodeJS.ProcessEnv;
  readonly terminationGraceMs?: number;
  readonly maxOutputBytes?: number;
  readonly signalChild?: (child: CursorChildProcess, signal: NodeJS.Signals) => void;
};

export function createCursorCliBackend(
  config: BridgeConfig,
  dependencies: CursorCliBackendDependencies = {},
): CursorBackend {
  const environment = dependencies.environment ?? process.env;
  const childRegistry = new CursorChildRegistry();
  const executeCommand =
    dependencies.commandRunner ??
    createCursorCommandRunner({
      registry: childRegistry,
      spawn: dependencies.spawn,
      env: environment,
      terminationGraceMs: dependencies.terminationGraceMs,
      maxOutputBytes: dependencies.maxOutputBytes,
      signalChild: dependencies.signalChild,
    });
  const cursorBin = environment.CURSOR_BRIDGE_CURSOR_BIN || 'cursor';
  const context: CursorCliCompletionContext = {
    config,
    executeCommand,
    cursorBin,
    timeoutMs: validCursorTimeoutMs(environment.CURSOR_BRIDGE_CURSOR_TIMEOUT_MS),
  };
  let modelCache: { readonly expiresAt: number; readonly models: BridgeModel[] } | undefined;
  let modelRefresh: Promise<BridgeModel[]> | undefined;

  const discoverModels = async (): Promise<BridgeModel[]> => {
    let models: BridgeModel[];
    try {
      const output = await executeCommand(
        cursorBin,
        cursorModelsArgs(cursorBin),
        process.cwd(),
        MODEL_DISCOVERY_TIMEOUT_MS,
      );
      models = parseCursorModels(output);
      if (models.length === 0) models = defaultCursorModels();
    } catch {
      models = defaultCursorModels();
    }

    if (config.defaultModel && !models.some((model) => model.id === config.defaultModel)) {
      models.unshift(cursorModel(config.defaultModel));
    }
    modelCache = { expiresAt: Date.now() + MODEL_CACHE_TTL_MS, models };
    return models;
  };

  return {
    type: 'cursor-cli',
    async health() {
      try {
        await executeCommand(cursorBin, ['--version'], process.cwd(), 10_000);
        return {
          ok: true,
          type: 'cursor-cli',
          authConfigured: Boolean(environment.CURSOR_AUTH_TOKEN || environment.CURSOR_API_KEY),
          detail: `${cursorBin} available`,
        };
      } catch {
        return {
          ok: false,
          type: 'cursor-cli',
          authConfigured: Boolean(environment.CURSOR_AUTH_TOKEN || environment.CURSOR_API_KEY),
          detail: 'cursor cli unavailable',
        };
      }
    },
    async listModels() {
      if (modelCache && modelCache.expiresAt > Date.now()) return [...modelCache.models];
      if (!modelRefresh) {
        modelRefresh = discoverModels().finally(() => {
          modelRefresh = undefined;
        });
      }
      return [...(await modelRefresh)];
    },
    completeStream(request, signal) {
      return completeCursorStream(context, request, signal);
    },
    complete(request, signal) {
      return completeCursor(context, request, signal);
    },
    async shutdown() {
      await childRegistry.shutdown();
    },
  };
}
