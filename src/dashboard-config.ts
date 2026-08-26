import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import type {
  CursorApiCredential,
  CursorApiCredentialInput,
} from './backend/cursor-api/credentials.js';
import {
  CURSOR_CREDENTIAL_FAILOVER_POLICIES,
  CURSOR_CREDENTIAL_ROUTING_POLICIES,
} from './backend/cursor-api/credential-policy.js';

const credentialSchema = z
  .object({
    id: z.string().trim().min(1).max(100),
    label: z.string().trim().min(1).max(200).optional(),
    apiKey: z.string().trim().min(1),
    weight: z.number().positive().default(1),
    enabled: z.boolean().default(true),
  })
  .strict();

export const dashboardConfigSchema = z
  .object({
    server: z
      .object({
        host: z.string().trim().min(1).optional(),
        port: z.number().int().positive().max(65_535).optional(),
      })
      .strict()
      .optional(),
    credentials: z.array(credentialSchema).optional(),
    credentialPolicy: z
      .object({
        routingPolicy: z.enum(CURSOR_CREDENTIAL_ROUTING_POLICIES).optional(),
        failoverOn: z.enum(CURSOR_CREDENTIAL_FAILOVER_POLICIES).optional(),
      })
      .strict()
      .optional(),
    modelOverrides: z.record(z.string(), z.boolean()).optional(),
  })
  .strict()
  .superRefine((config, context) => {
    const ids = new Set<string>();
    for (const [index, credential] of (config.credentials ?? []).entries()) {
      if (credential.id === 'env' || credential.id === 'system') {
        context.addIssue({
          code: 'custom',
          path: ['credentials', index, 'id'],
          message: `credential id '${credential.id}' is reserved`,
        });
      }
      if (ids.has(credential.id)) {
        context.addIssue({
          code: 'custom',
          path: ['credentials', index, 'id'],
          message: `duplicate credential id '${credential.id}'`,
        });
      }
      ids.add(credential.id);
    }
  });

export type DashboardCredential = z.infer<typeof credentialSchema>;
export type DashboardConfig = z.infer<typeof dashboardConfigSchema>;

export interface RedactedCursorCredential {
  id: string;
  label?: string;
  weight: number;
  enabled: boolean;
  apiKeyPreview?: string;
}

function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return resolve(homedir(), path.slice(2));
  return path;
}

export function dashboardConfigPath(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): string {
  const configured = environment.CURSOR_BRIDGE_DASHBOARD_CONFIG?.trim();
  return configured
    ? expandHome(configured)
    : resolve(homedir(), '.config', 'cursor-ai-proxy-bridge', 'dashboard.json');
}

export function readDashboardConfigFile(
  path: string,
  warn: (message: string) => void = console.warn,
): DashboardConfig {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const result = dashboardConfigSchema.safeParse(parsed);
    if (result.success) return result.data;
    warn(`Ignoring invalid Cursor Bridge dashboard config at ${path}`);
    return {};
  } catch {
    warn(`Ignoring unreadable Cursor Bridge dashboard config at ${path}`);
    return {};
  }
}

export function writeDashboardConfigFile(path: string, config: DashboardConfig): void {
  const validated = dashboardConfigSchema.parse(config);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function redactedCredentials(
  credentials: ReadonlyArray<CursorApiCredential | CursorApiCredentialInput>,
): RedactedCursorCredential[] {
  return credentials.map((credential) => {
    const redacted: RedactedCursorCredential = {
      id: credential.id,
      weight: credential.weight ?? 1,
      enabled: credential.enabled !== false,
    };
    if (credential.label !== undefined) redacted.label = credential.label;
    if (credential.apiKey) {
      redacted.apiKeyPreview =
        credential.apiKey.length <= 4 ? '…' : `${credential.apiKey.slice(0, 4)}…`;
    }
    return redacted;
  });
}
