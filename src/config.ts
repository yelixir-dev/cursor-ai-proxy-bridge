import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

export type BackendKind = 'mock' | 'cursor-cli';
export type WorkspaceMode = 'chat-only' | 'real-workspace';

export interface BridgeConfig {
  host: string;
  port: number;
  apiKey?: string;
  backend: BackendKind;
  defaultModel: string;
  workspaceMode: WorkspaceMode;
  realWorkspacePath?: string;
  version: string;
}

function packageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(resolve(here, '..', 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadConfig(envFile = '.env'): BridgeConfig {
  dotenv.config({ path: envFile, quiet: true });
  const workspaceMode =
    process.env.CURSOR_BRIDGE_WORKSPACE_MODE === 'real-workspace' ? 'real-workspace' : 'chat-only';

  return {
    host: process.env.CURSOR_BRIDGE_HOST || '127.0.0.1',
    port: numberFromEnv('CURSOR_BRIDGE_PORT', 9994),
    apiKey: process.env.CURSOR_BRIDGE_API_KEY,
    backend: process.env.CURSOR_BRIDGE_BACKEND === 'cursor-cli' ? 'cursor-cli' : 'mock',
    defaultModel: process.env.CURSOR_BRIDGE_DEFAULT_MODEL || 'cursor-fast',
    workspaceMode,
    realWorkspacePath:
      workspaceMode === 'real-workspace' ? process.env.CURSOR_BRIDGE_REAL_WORKSPACE : undefined,
    version: packageVersion(),
  };
}

export function redactedConfig(config: BridgeConfig) {
  return {
    host: config.host,
    port: config.port,
    backend: config.backend,
    defaultModel: config.defaultModel,
    workspaceMode: config.workspaceMode,
    realWorkspaceConfigured: Boolean(config.realWorkspacePath),
    clientApiKeyConfigured: Boolean(config.apiKey),
    version: config.version,
  };
}
