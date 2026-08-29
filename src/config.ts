import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import {
  type CursorApiCredential,
  cursorCredentialsFromConfig,
} from './backend/cursor-api/credentials.js';
import {
  type DashboardConfig,
  dashboardConfigPath,
  readDashboardConfigFile,
} from './dashboard-config.js';

export type BackendKind = 'auto' | 'mock' | 'cursor-cli' | 'cursor-api';

export const BRIDGE_ENV_FILE = '.env';
export type WorkspaceMode = 'chat-only' | 'real-workspace';
export type ClientAuthMode = 'on' | 'off';

export interface BridgeConfig {
  host: string;
  port: number;
  apiKey?: string;
  clientAuth?: ClientAuthMode;
  backend: BackendKind;
  defaultModel: string;
  workspaceMode: WorkspaceMode;
  realWorkspacePath?: string;
  maxConcurrency?: number;
  maxConcurrencyPerKey?: number;
  /** Prefer Cursor's `isMaxMode` variant when the model publishes one. */
  maxModeDefault?: boolean;
  version: string;
  dashboardConfigPath?: string;
  dashboardConfig?: DashboardConfig;
  cursorApiCredentials?: CursorApiCredential[];
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

function booleanFromEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${name} must be either true or false`);
}

export function loadConfig(envFile: string = BRIDGE_ENV_FILE): BridgeConfig {
  dotenv.config({ path: envFile, quiet: true });
  const configPath = dashboardConfigPath(process.env);
  const dashboardConfig = readDashboardConfigFile(configPath);
  const workspaceMode =
    process.env.CURSOR_BRIDGE_WORKSPACE_MODE === 'real-workspace' ? 'real-workspace' : 'chat-only';
  const rawApiKey = process.env.CURSOR_BRIDGE_API_KEY;
  const apiKey = rawApiKey?.trim();
  if (rawApiKey !== undefined && !apiKey) {
    throw new Error('CURSOR_BRIDGE_API_KEY must not be empty or whitespace');
  }
  const rawClientAuth = process.env.CURSOR_BRIDGE_AUTH;
  if (rawClientAuth !== undefined && rawClientAuth !== 'on' && rawClientAuth !== 'off') {
    throw new Error('CURSOR_BRIDGE_AUTH must be either on or off');
  }
  const clientAuth = rawClientAuth ?? (apiKey ? 'on' : 'off');
  if (clientAuth === 'on' && !apiKey) {
    throw new Error('CURSOR_BRIDGE_AUTH=on requires CURSOR_BRIDGE_API_KEY');
  }

  return {
    host: process.env.CURSOR_BRIDGE_HOST || dashboardConfig.server?.host || '127.0.0.1',
    port: numberFromEnv('CURSOR_BRIDGE_PORT', dashboardConfig.server?.port ?? 9997),
    apiKey,
    clientAuth,
    backend:
      process.env.CURSOR_BRIDGE_BACKEND === 'cursor-api' ||
      process.env.CURSOR_BRIDGE_BACKEND === 'cursor-cli' ||
      process.env.CURSOR_BRIDGE_BACKEND === 'mock'
        ? process.env.CURSOR_BRIDGE_BACKEND
        : 'auto',
    defaultModel: process.env.CURSOR_BRIDGE_DEFAULT_MODEL || 'composer-2.5',
    workspaceMode,
    realWorkspacePath:
      workspaceMode === 'real-workspace' ? process.env.CURSOR_BRIDGE_REAL_WORKSPACE : undefined,
    maxConcurrency: numberFromEnv('CURSOR_BRIDGE_MAX_CONCURRENCY', 16),
    maxConcurrencyPerKey: numberFromEnv('CURSOR_BRIDGE_MAX_CONCURRENCY_PER_KEY', 16),
    maxModeDefault: booleanFromEnv(
      'CURSOR_BRIDGE_MAX_MODE_DEFAULT',
      dashboardConfig.maxModeDefault ?? false,
    ),
    version: packageVersion(),
    dashboardConfigPath: configPath,
    dashboardConfig,
    cursorApiCredentials: cursorCredentialsFromConfig(
      process.env,
      dashboardConfig.credentials ?? [],
      dashboardConfig.envCredentialMetadata,
    ),
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
    clientAuthEnabled: config.clientAuth === 'on',
    maxModeDefault: config.maxModeDefault === true,
    version: config.version,
  };
}
