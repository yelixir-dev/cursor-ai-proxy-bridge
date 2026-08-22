import type { TraceRetryDecline, TraceRetryReason } from '../../trace-contract.js';
import { ConnectRpcError } from './connect-frame.js';
import { inspectCursorProviderError } from './provider-error.js';
import { CursorRunTimeoutError } from './run-errors.js';
import { CursorApiHttpError } from './transport.js';

const RETRYABLE_TRANSPORT_CODES = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ERR_CURSOR_RUN_NO_TRAILER',
  'ERR_HTTP2_GOAWAY_SESSION',
  'ERR_HTTP2_INVALID_SESSION',
  'ERR_HTTP2_SESSION_ERROR',
  'ERR_HTTP2_STREAM_CANCEL',
  'ERR_STREAM_PREMATURE_CLOSE',
  'ETIMEDOUT',
]);
const RETRYABLE_SERVER_CODES = new Set(['internal', 'resource_exhausted', 'unknown']);
const RETRYABLE_CONNECT_TRANSPORT_CODES = new Set(['deadline_exceeded', 'unavailable']);
const NON_RETRYABLE_CURSOR_ERROR_TYPES = new Set([
  'FREE_USER_RATE_LIMIT_EXCEEDED',
  'FREE_USER_USAGE_LIMIT',
  'GENERIC_RATE_LIMIT_EXCEEDED',
  'PRO_USER_ONLY',
  'PRO_USER_RATE_LIMIT_EXCEEDED',
  'PRO_USER_USAGE_LIMIT',
  'RATE_LIMITED',
  'RATE_LIMITED_CHANGEABLE',
]);

export type RetryFailureKind = 'server' | 'transport';
export interface CursorRetryOptions {
  readonly retryProvider5xx?: boolean;
}

interface ConnectDetailsPolicy {
  readonly nonRetryable: boolean;
  readonly permanent: boolean;
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== 'object' || !('code' in error)) return '';
  return String(error.code ?? '');
}

function connectDetailsPolicy(details: unknown): ConnectDetailsPolicy {
  const pending: unknown[] = [details];
  const seen = new Set<unknown>();
  let nonRetryable = false;
  while (pending.length) {
    const value = pending.pop();
    if (value === null || value === undefined || seen.has(value)) continue;
    seen.add(value);
    if (typeof value === 'string') {
      if ([...NON_RETRYABLE_CURSOR_ERROR_TYPES].some((type) => value.includes(type))) {
        return { nonRetryable: true, permanent: true };
      }
      continue;
    }
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    if (typeof value !== 'object') continue;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'isRetryable' && child === false) nonRetryable = true;
      if (
        ['errorType', 'reason', 'type'].includes(key) &&
        typeof child === 'string' &&
        NON_RETRYABLE_CURSOR_ERROR_TYPES.has(child)
      ) {
        return { nonRetryable: true, permanent: true };
      }
      pending.push(child);
    }
  }
  return { nonRetryable, permanent: false };
}

type ConnectRetryDecision = RetryFailureKind | 'terminal';

function connectRetryDecision(
  error: ConnectRpcError,
  options: CursorRetryOptions,
): ConnectRetryDecision | undefined {
  const detailsPolicy = connectDetailsPolicy(error.details);
  const provider = inspectCursorProviderError(error);
  if (
    detailsPolicy.permanent ||
    provider.nonProviderNonRetryable ||
    provider.providerRetryableConflict
  ) {
    return 'terminal';
  }
  if (
    options.retryProvider5xx &&
    provider.providerError &&
    provider.retryProvider5xx &&
    error.code === 'resource_exhausted'
  ) {
    return 'server';
  }
  if (detailsPolicy.nonRetryable || provider.diagnostics?.upstreamRetryable === false) {
    return 'terminal';
  }
  return undefined;
}

function nestedConnectRetryDecision(
  error: unknown,
  options: CursorRetryOptions,
): ConnectRetryDecision | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  let retryDecision: RetryFailureKind | undefined;
  for (let depth = 0; current !== undefined && current !== null && depth < 10; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    if (
      current instanceof CursorApiHttpError &&
      !(current.status >= 500 && current.status <= 599)
    ) {
      return 'terminal';
    }
    if (current instanceof ConnectRpcError) {
      const decision = connectRetryDecision(current, options);
      if (decision === 'terminal') return 'terminal';
      if (decision !== undefined) retryDecision = decision;
    }
    if (current && typeof current === 'object' && 'cause' in current) {
      current = current.cause;
      continue;
    }
    break;
  }
  return retryDecision;
}

export function cursorRetryFailureKind(
  error: unknown,
  options: CursorRetryOptions = {},
): RetryFailureKind | undefined {
  const nestedDecision = nestedConnectRetryDecision(error, options);
  if (nestedDecision === 'terminal') return undefined;
  if (nestedDecision !== undefined) return nestedDecision;

  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; current !== undefined && current !== null && depth < 10; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    if (current instanceof CursorApiHttpError) {
      return current.status >= 500 && current.status <= 599 ? 'server' : undefined;
    }
    if (current instanceof ConnectRpcError) {
      const decision = connectRetryDecision(current, options);
      if (decision === 'terminal') return undefined;
      if (decision !== undefined) return decision;
    }
    const code = errorCode(current);
    const message = current instanceof Error ? current.message : String(current);
    if (
      RETRYABLE_TRANSPORT_CODES.has(code) ||
      /http\/?2|NGHTTP2|socket|stream closed|truncated connect|invalid gzip/i.test(message)
    ) {
      return 'transport';
    }
    if (current instanceof ConnectRpcError) {
      if (RETRYABLE_CONNECT_TRANSPORT_CODES.has(current.code ?? '')) return 'transport';
      if (!current.code || RETRYABLE_SERVER_CODES.has(current.code)) return 'server';
      return undefined;
    }
    if (current && typeof current === 'object' && 'cause' in current) {
      current = current.cause;
      continue;
    }
    break;
  }
  return undefined;
}

export function isRetryableCursorTransportError(error: unknown): boolean {
  return cursorRetryFailureKind(error) !== undefined;
}

/** True when the typed provider-5xx opt-in would retry this error chain. */
export function isProvider5xxEligible(error: unknown): boolean {
  return nestedConnectRetryDecision(error, { retryProvider5xx: true }) === 'server';
}

export interface CursorRetryDecision {
  readonly retryProvider5xx: boolean;
  readonly retryRunTimeout: boolean;
  readonly delivered: boolean;
  readonly aborted: boolean;
  readonly serverRetryExhausted: boolean;
}

export interface CursorRetryClassification {
  readonly kind: RetryFailureKind | undefined;
  readonly declineReason: TraceRetryDecline | undefined;
  readonly retryReason: TraceRetryReason | undefined;
}

/**
 * One classification per caught failure: the retry kind plus the bounded
 * telemetry for why an eligible provider-5xx retry was declined and which
 * opt-in path an emitted retry came from.
 */
export function classifyCursorRetry(
  error: unknown,
  decision: CursorRetryDecision,
): CursorRetryClassification {
  const timeoutRetry = decision.retryRunTimeout && error instanceof CursorRunTimeoutError;
  const kind = timeoutRetry
    ? 'transport'
    : cursorRetryFailureKind(error, { retryProvider5xx: decision.retryProvider5xx });
  const eligible = isProvider5xxEligible(error);
  const provider5xxRetry = decision.retryProvider5xx && eligible && kind === 'server';
  let declineReason: TraceRetryDecline | undefined;
  if (provider5xxRetry) {
    if (decision.delivered) declineReason = 'post_visible';
    else if (!decision.aborted && decision.serverRetryExhausted) declineReason = 'retry_limit';
  } else if (!decision.retryProvider5xx && eligible && kind === undefined) {
    declineReason = 'flag_off';
  }
  return {
    kind,
    declineReason,
    retryReason: timeoutRetry ? 'run_timeout' : provider5xxRetry ? 'provider_5xx' : undefined,
  };
}
