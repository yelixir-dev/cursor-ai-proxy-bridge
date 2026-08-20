const MAX_CREDENTIAL_STRING_LENGTH = 65_536;
const INVALID_CURSOR_CREDENTIAL = 'benchmark auth store requires a valid cursor OAuth credential';

export interface CursorOAuthCredential {
  type: 'oauth';
  access: string;
  refresh: string;
  expires: number;
}

export class AuthStoreError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'AuthStoreError';
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isCredentialText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_CREDENTIAL_STRING_LENGTH &&
    value.trim().length > 0
  );
}

function parseCursorCredential(value: unknown): CursorOAuthCredential {
  if (!isPlainRecord(value) || value.type !== 'oauth') {
    throw new AuthStoreError(INVALID_CURSOR_CREDENTIAL);
  }
  const { access, refresh, expires } = value;
  if (
    !isCredentialText(access) ||
    !isCredentialText(refresh) ||
    typeof expires !== 'number' ||
    !Number.isSafeInteger(expires) ||
    expires < 0
  ) {
    throw new AuthStoreError(INVALID_CURSOR_CREDENTIAL);
  }
  return { type: 'oauth', access, refresh, expires };
}

export interface NativeCursorAuthSnapshot {
  cursor: CursorOAuthCredential;
}

export function parseNativeCursorAuthContents(contents: string): NativeCursorAuthSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch {
    throw new AuthStoreError('benchmark auth store is not valid JSON');
  }
  if (!isPlainRecord(parsed)) {
    throw new AuthStoreError('benchmark auth store must be a plain object');
  }
  return { cursor: parseCursorCredential(parsed.cursor) };
}

export function serializeNativeCursorAuth(snapshot: NativeCursorAuthSnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

export function sanitizeAuthContents(contents: string): string {
  return serializeNativeCursorAuth(parseNativeCursorAuthContents(contents));
}
