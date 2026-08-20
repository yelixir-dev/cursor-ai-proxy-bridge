import { ConnectRpcError } from './connect-frame.js';
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

function errorCode(error: unknown): string {
  if (!error || typeof error !== 'object' || !('code' in error)) return '';
  return String(error.code ?? '');
}

function hasNonRetryableConnectDetails(details: unknown): boolean {
  const pending: unknown[] = [details];
  const seen = new Set<unknown>();
  while (pending.length) {
    const value = pending.pop();
    if (value === null || value === undefined || seen.has(value)) continue;
    seen.add(value);
    if (typeof value === 'string') {
      if ([...NON_RETRYABLE_CURSOR_ERROR_TYPES].some((type) => value.includes(type))) return true;
      continue;
    }
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    if (typeof value !== 'object') continue;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'isRetryable' && child === false) return true;
      if (
        ['errorType', 'reason', 'type'].includes(key) &&
        typeof child === 'string' &&
        NON_RETRYABLE_CURSOR_ERROR_TYPES.has(child)
      ) {
        return true;
      }
      pending.push(child);
    }
  }
  return false;
}

export function cursorRetryFailureKind(error: unknown): RetryFailureKind | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; current !== undefined && current !== null && depth < 10; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    if (current instanceof CursorApiHttpError) {
      return current.status >= 500 && current.status <= 599 ? 'server' : undefined;
    }
    if (current instanceof ConnectRpcError && hasNonRetryableConnectDetails(current.details)) {
      return undefined;
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
