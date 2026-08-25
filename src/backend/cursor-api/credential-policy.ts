import { ConnectRpcError } from './connect-frame.js';
import { inspectCursorProviderError } from './provider-error.js';
import { decodeProviderErrorValue } from './provider-error-protobuf.js';
import { CursorApiHttpError } from './transport.js';

const ERROR_DETAILS_TYPE = 'aiserver.v1.ErrorDetails';
const MAX_CAUSE_DEPTH = 10;
const BILLING_ERROR_NUMBERS = new Set([9, 10]);
const COOLDOWN_ERROR_NUMBERS = new Set([7, 8, 22, 50, 51]);

export const CURSOR_CREDENTIAL_ROUTING_POLICIES = ['weighted_round_robin', 'round_robin'] as const;
export type CursorCredentialRoutingPolicy = (typeof CURSOR_CREDENTIAL_ROUTING_POLICIES)[number];

export const CURSOR_CREDENTIAL_FAILOVER_POLICIES = [
  'auth',
  'auth_or_quota',
  'auth_or_quota_or_5xx',
] as const;
export type CursorCredentialFailoverPolicy = (typeof CURSOR_CREDENTIAL_FAILOVER_POLICIES)[number];

export type CredentialDisabledReason = 'auth' | 'billing' | 'cooldown';

export interface CursorCredentialPolicyConfig {
  readonly routingPolicy: CursorCredentialRoutingPolicy;
  readonly failoverOn: CursorCredentialFailoverPolicy;
}

export class CursorCredentialPolicyConfigError extends Error {
  readonly name = 'CursorCredentialPolicyConfigError';

  constructor(
    readonly variable: string,
    readonly value: string,
    readonly allowed: readonly string[],
  ) {
    super(`${variable} must be one of ${allowed.join(', ')}; received ${JSON.stringify(value)}`);
  }
}

function routingPolicy(value: string | undefined): CursorCredentialRoutingPolicy {
  const normalized = value?.trim();
  if (normalized === undefined || normalized === '') return 'weighted_round_robin';
  if (normalized === 'weighted_round_robin' || normalized === 'round_robin') return normalized;
  throw new CursorCredentialPolicyConfigError(
    'CURSOR_BRIDGE_CREDENTIAL_ROUTING',
    normalized,
    CURSOR_CREDENTIAL_ROUTING_POLICIES,
  );
}

function failoverPolicy(value: string | undefined): CursorCredentialFailoverPolicy {
  const normalized = value?.trim();
  if (normalized === undefined || normalized === '') return 'auth';
  if (
    normalized === 'auth' ||
    normalized === 'auth_or_quota' ||
    normalized === 'auth_or_quota_or_5xx'
  ) {
    return normalized;
  }
  throw new CursorCredentialPolicyConfigError(
    'CURSOR_BRIDGE_FAILOVER_ON',
    normalized,
    CURSOR_CREDENTIAL_FAILOVER_POLICIES,
  );
}

export function cursorCredentialPolicyFromEnv(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
): CursorCredentialPolicyConfig {
  return {
    routingPolicy: routingPolicy(environment.CURSOR_BRIDGE_CREDENTIAL_ROUTING),
    failoverOn: failoverPolicy(environment.CURSOR_BRIDGE_FAILOVER_ON),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorTypeFailureReason(value: string): CredentialDisabledReason | undefined {
  if (value.includes('USER_USAGE_LIMIT') || value.includes('BILLING')) return 'billing';
  if (
    value.includes('USER_RATE_LIMIT_EXCEEDED') ||
    value.includes('GENERIC_RATE_LIMIT_EXCEEDED') ||
    value.includes('RATE_LIMITED')
  ) {
    return 'cooldown';
  }
  return undefined;
}

function detailsFailureReason(details: unknown): CredentialDisabledReason | undefined {
  const pending: unknown[] = [details];
  const seen = new Set<unknown>();
  const reasons = new Set<CredentialDisabledReason>();
  while (pending.length > 0) {
    const value = pending.pop();
    if (value === null || value === undefined || seen.has(value)) continue;
    seen.add(value);
    if (typeof value === 'string') {
      const reason = errorTypeFailureReason(value);
      if (reason !== undefined) reasons.add(reason);
      continue;
    }
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    if (!isRecord(value)) continue;
    const object = value;
    if (object.type === ERROR_DETAILS_TYPE && typeof object.value === 'string') {
      const decoded = decodeProviderErrorValue(object.value);
      if (decoded?.errorNumber !== undefined) {
        if (BILLING_ERROR_NUMBERS.has(decoded.errorNumber)) reasons.add('billing');
        if (COOLDOWN_ERROR_NUMBERS.has(decoded.errorNumber)) reasons.add('cooldown');
      }
      const reason =
        decoded?.errorType === undefined ? undefined : errorTypeFailureReason(decoded.errorType);
      if (reason !== undefined) reasons.add(reason);
    }
    pending.push(...Object.values(object));
  }
  if (reasons.size !== 1) return undefined;
  for (const reason of reasons) return reason;
  return undefined;
}

interface FailureSignals {
  readonly status?: number;
  readonly connectCode?: string;
  readonly detailsReason?: CredentialDisabledReason;
}

function failureSignals(error: unknown): FailureSignals {
  let current = error;
  let status: number | undefined;
  let connectCode: string | undefined;
  let detailsReason: CredentialDisabledReason | undefined;
  const seen = new Set<unknown>();
  for (let depth = 0; current !== undefined && depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    if (current instanceof CursorApiHttpError) status ??= current.status;
    if (current instanceof ConnectRpcError) {
      connectCode ??= current.code;
      detailsReason ??= detailsFailureReason(current.details);
    } else {
      if (status === undefined && isRecord(current) && 'status' in current) {
        const value = current;
        const candidate = Number(value.status);
        if (Number.isInteger(candidate)) status = candidate;
      }
    }
    current = isRecord(current) ? current.cause : undefined;
  }
  return {
    ...(status === undefined ? {} : { status }),
    ...(connectCode === undefined ? {} : { connectCode }),
    ...(detailsReason === undefined ? {} : { detailsReason }),
  };
}

function classifiedFailureReason(error: unknown): CredentialDisabledReason | undefined {
  const provider = inspectCursorProviderError(error);
  const signals = failureSignals(error);
  if (
    !provider.providerError &&
    !provider.nonProviderNonRetryable &&
    (signals.status === 401 || signals.status === 403 || signals.connectCode === 'unauthenticated')
  ) {
    return 'auth';
  }
  if (signals.status === 402 || signals.detailsReason === 'billing') return 'billing';
  if (
    signals.status === 429 ||
    (signals.status !== undefined && signals.status >= 500 && signals.status <= 599) ||
    signals.detailsReason === 'cooldown' ||
    (provider.providerError && signals.connectCode === 'resource_exhausted')
  ) {
    return 'cooldown';
  }
  return undefined;
}

function policyAllows(
  policy: CursorCredentialFailoverPolicy,
  reason: CredentialDisabledReason,
): boolean {
  switch (policy) {
    case 'auth':
      return reason === 'auth';
    case 'auth_or_quota':
      return reason === 'auth' || reason === 'billing';
    case 'auth_or_quota_or_5xx':
      return true;
    default: {
      const exhaustive: never = policy;
      return exhaustive;
    }
  }
}

export function cursorCredentialFailureReason(
  error: unknown,
  policy: CursorCredentialFailoverPolicy,
): CredentialDisabledReason | undefined {
  const reason = classifiedFailureReason(error);
  return reason !== undefined && policyAllows(policy, reason) ? reason : undefined;
}
