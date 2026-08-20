export const CURSOR_BOOTSTRAP_UNARY_HEADER_NAMES = [
  'accept-encoding',
  'authorization',
  'connect-protocol-version',
  'content-type',
  'user-agent',
] as const;

export const CURSOR_UNARY_HEADER_NAMES = [
  'accept-encoding',
  'authorization',
  'connect-protocol-version',
  'content-type',
  'user-agent',
  'x-cursor-client-type',
  'x-cursor-client-version',
  'x-ghost-mode',
  'x-request-id',
] as const;

export const CURSOR_RUN_HEADER_NAMES = [
  'authorization',
  'backend-traceparent',
  'connect-accept-encoding',
  'connect-content-encoding',
  'connect-protocol-version',
  'content-type',
  'traceparent',
  'user-agent',
  'x-blob-encryption-key',
  'x-cursor-client-type',
  'x-cursor-client-version',
  'x-ghost-mode',
  'x-original-request-id',
  'x-request-id',
] as const;
