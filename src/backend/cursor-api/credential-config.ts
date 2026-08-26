import type { CursorCredentialCapabilities, CursorCredentialPlan } from './credential-plan.js';

export interface CursorApiCredential {
  id: string;
  label?: string;
  apiKey?: string;
  weight: number;
  enabled: boolean;
  plan?: CursorCredentialPlan;
  capabilities?: CursorCredentialCapabilities;
}

export interface CursorApiCredentialInput {
  id: string;
  label?: string;
  apiKey?: string;
  weight?: number;
  enabled?: boolean;
  plan?: CursorCredentialPlan;
  capabilities?: CursorCredentialCapabilities;
}

export interface CursorApiCredentialMetadata {
  readonly plan?: CursorCredentialPlan;
  readonly capabilities?: CursorCredentialCapabilities;
}

function positiveWeight(value: number | undefined): number {
  return Number.isFinite(value) && value !== undefined && value > 0 ? value : 1;
}

export function normalizeCursorApiCredential(
  credential: CursorApiCredentialInput,
): CursorApiCredential {
  const normalized: CursorApiCredential = {
    id: credential.id,
    weight: positiveWeight(credential.weight),
    enabled: credential.enabled !== false,
  };
  if (credential.label !== undefined) normalized.label = credential.label;
  if (credential.apiKey !== undefined) normalized.apiKey = credential.apiKey;
  if (credential.plan !== undefined) normalized.plan = credential.plan;
  if (credential.capabilities !== undefined) {
    normalized.capabilities = { ...credential.capabilities };
  }
  return normalized;
}

export function cursorCredentialsFromConfig(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
  dashboardCredentials: CursorApiCredentialInput[] = [],
  envMetadata: CursorApiCredentialMetadata = {},
): CursorApiCredential[] {
  const credentials: CursorApiCredential[] = [];
  const envApiKey = environment.CURSOR_API_KEY?.trim();
  if (envApiKey) {
    credentials.push(
      normalizeCursorApiCredential({
        id: 'env',
        apiKey: envApiKey,
        ...envMetadata,
      }),
    );
  }

  const used = new Set(credentials.map((credential) => credential.id));
  for (const credential of dashboardCredentials) {
    if (used.has(credential.id)) continue;
    used.add(credential.id);
    credentials.push(normalizeCursorApiCredential(credential));
  }

  if (credentials.length === 0) {
    credentials.push(normalizeCursorApiCredential({ id: 'system' }));
  }
  return credentials;
}
