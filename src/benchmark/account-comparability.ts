import { CursorAuthProvider } from '../backend/cursor-api/auth.js';
import {
  cursorCredentialsFromConfig,
  type CursorApiCredential,
} from '../backend/cursor-api/credentials.js';
import { z } from 'zod';
import { dashboardConfigPath, readDashboardConfigFile } from '../dashboard-config.js';

const JwtSubjectPayloadSchema = z.object({ sub: z.string().trim().min(1) });

export type AccountComparisonStatus = 'matched' | 'mismatched' | 'unproved';
export type AccountIdentityStatus =
  | 'unverified_claim_match'
  | 'unverified_claim_mismatch'
  | 'unproved';
export type AccountComparisonMethod = 'jwt_sub' | 'none';
export type AccountComparisonReason =
  | 'stable_claim_equal'
  | 'stable_claim_different'
  | 'native_credential_opaque'
  | 'native_credential_malformed'
  | 'bridge_credential_missing'
  | 'bridge_credential_ambiguous'
  | 'bridge_credential_opaque'
  | 'bridge_credential_malformed'
  | 'bridge_exchange_failed'
  | 'dry_run';

export interface AccountComparability {
  readonly status: AccountComparisonStatus;
  readonly method: AccountComparisonMethod;
  readonly reason: AccountComparisonReason;
  readonly identity_status: AccountIdentityStatus;
  readonly cryptographic_identity_proven: false;
  readonly native_claim_available: boolean;
  readonly bridge_claim_available: boolean;
  readonly bridge_exchange_available: boolean;
  readonly account_mismatch: boolean;
  readonly latency_confounded: boolean;
}

interface ClaimResult {
  claim?: string;
  unavailable: 'opaque' | 'malformed';
}

export interface AccountComparisonDependencies {
  authProvider?: (environment: NodeJS.ProcessEnv) => Pick<CursorAuthProvider, 'getToken'>;
  bridgeCredentials?: (environment: NodeJS.ProcessEnv) => readonly CursorApiCredential[];
}

function stableClaim(token: string): ClaimResult {
  const parts = token.trim().split('.');
  if (parts.length !== 3) return { unavailable: 'opaque' };
  const payloadPart = parts[1];
  if (!payloadPart) return { unavailable: 'malformed' };
  try {
    const payload: unknown = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
    const parsed = JwtSubjectPayloadSchema.safeParse(payload);
    return parsed.success
      ? { claim: parsed.data.sub, unavailable: 'malformed' }
      : { unavailable: 'malformed' };
  } catch {
    return { unavailable: 'malformed' };
  }
}

export function unprovedAccountComparability(
  reason: Extract<AccountComparisonReason, 'bridge_credential_missing' | 'dry_run'>,
): AccountComparability {
  return {
    status: 'unproved',
    method: 'none',
    reason,
    identity_status: 'unproved',
    cryptographic_identity_proven: false,
    native_claim_available: false,
    bridge_claim_available: false,
    bridge_exchange_available: false,
    account_mismatch: true,
    latency_confounded: true,
  };
}

function unproved(
  reason: Exclude<AccountComparisonReason, 'stable_claim_equal' | 'stable_claim_different'>,
  availability: Pick<
    AccountComparability,
    'native_claim_available' | 'bridge_claim_available' | 'bridge_exchange_available'
  >,
): AccountComparability {
  return {
    status: 'unproved',
    method: availability.native_claim_available ? 'jwt_sub' : 'none',
    reason,
    identity_status: 'unproved',
    cryptographic_identity_proven: false,
    ...availability,
    account_mismatch: true,
    latency_confounded: true,
  };
}

export async function compareBenchmarkAccounts(
  nativeAccess: string,
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  dependencies: AccountComparisonDependencies = {},
): Promise<AccountComparability> {
  const native = stableClaim(nativeAccess);
  if (!native.claim) {
    return unproved(`native_credential_${native.unavailable}`, {
      native_claim_available: false,
      bridge_claim_available: false,
      bridge_exchange_available: false,
    });
  }

  const direct = environment.CURSOR_AUTH_TOKEN?.trim();
  const configured =
    dependencies.bridgeCredentials?.(environment) ??
    cursorCredentialsFromConfig(
      environment,
      readDashboardConfigFile(dashboardConfigPath(environment), () => undefined).credentials ?? [],
    );
  const credentials = configured.filter((credential) => credential.enabled);
  if (credentials.length > 1) {
    return unproved('bridge_credential_ambiguous', {
      native_claim_available: true,
      bridge_claim_available: false,
      bridge_exchange_available: credentials.some((credential) => Boolean(credential.apiKey)),
    });
  }
  const credential = credentials[0];
  if (!credential || (!credential.apiKey && !direct)) {
    return unproved('bridge_credential_missing', {
      native_claim_available: true,
      bridge_claim_available: false,
      bridge_exchange_available: false,
    });
  }

  let bridgeAccess = direct;
  if (credential.apiKey) {
    try {
      const provider =
        dependencies.authProvider?.(environment) ?? new CursorAuthProvider({ environment });
      bridgeAccess = await provider.getToken(credential, signal);
    } catch {
      return unproved('bridge_exchange_failed', {
        native_claim_available: true,
        bridge_claim_available: false,
        bridge_exchange_available: true,
      });
    }
  }
  const bridge = stableClaim(bridgeAccess ?? '');
  if (!bridge.claim) {
    return unproved(`bridge_credential_${bridge.unavailable}`, {
      native_claim_available: true,
      bridge_claim_available: false,
      bridge_exchange_available: Boolean(credential.apiKey),
    });
  }
  const matched = native.claim === bridge.claim;
  return {
    status: matched ? 'matched' : 'mismatched',
    method: 'jwt_sub',
    reason: matched ? 'stable_claim_equal' : 'stable_claim_different',
    identity_status: matched ? 'unverified_claim_match' : 'unverified_claim_mismatch',
    cryptographic_identity_proven: false,
    native_claim_available: true,
    bridge_claim_available: true,
    bridge_exchange_available: Boolean(credential.apiKey),
    account_mismatch: !matched,
    latency_confounded: true,
  };
}
