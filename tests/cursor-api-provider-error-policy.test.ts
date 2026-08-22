import { describe, expect, it } from 'vitest';
import { ConnectRpcError } from '../src/backend/cursor-api/connect-frame.js';
import { isCredentialAuthFailure } from '../src/backend/cursor-api/credentials.js';
import {
  cursorProviderErrorDiagnostics,
  inspectCursorProviderError,
  safeCursorBackendError,
} from '../src/backend/cursor-api/provider-error.js';
import { decodeProviderErrorValue } from '../src/backend/cursor-api/provider-error-protobuf.js';
import { cursorRetryFailureKind } from '../src/backend/cursor-api/retry.js';
import { CursorApiHttpError } from '../src/backend/cursor-api/transport.js';
import {
  canonicalProviderDetailValue,
  providerDetails,
  providerError,
} from './support/provider-error-fixtures.js';

function canonicalProviderDetailValueWithRetryable(
  providerStatusCode: string,
  retryable: boolean,
): string {
  const binary = Buffer.from(canonicalProviderDetailValue(providerStatusCode), 'base64');
  const markerOffset = binary.indexOf(Buffer.from([0x20, 0x00]));
  if (markerOffset < 0) throw new Error('missing canonical retry marker');
  binary[markerOffset + 1] = retryable ? 1 : 0;
  return binary.toString('base64').replace(/=+$/u, '');
}

function additionalInfoEntry(key?: string, value?: string): Buffer {
  const fields: Buffer[] = [];
  if (key !== undefined) {
    const encoded = Buffer.from(key);
    fields.push(Buffer.from([0x0a, encoded.length]), encoded);
  }
  if (value !== undefined) {
    const encoded = Buffer.from(value);
    fields.push(Buffer.from([0x12, encoded.length]), encoded);
  }
  return Buffer.concat(fields);
}

function canonicalProviderDetailValueWithMapEntries(entries: readonly Buffer[]): string {
  const customDetails = Buffer.concat([
    Buffer.from([0x20, 0x00]),
    ...entries.flatMap((entry) => [Buffer.from([0x3a, entry.length]), entry]),
  ]);
  return Buffer.concat([Buffer.from([0x08, 0x39, 0x12, customDetails.length]), customDetails])
    .toString('base64')
    .replace(/=+$/u, '');
}

const malformedNestedMapEntryValue = Buffer.from(
  '0839122020003a190a1270726f7669646572537461747573436f646512033530333a010f',
  'hex',
)
  .toString('base64')
  .replace(/=+$/u, '');
const exactSingleOuterFieldValue = Buffer.from(
  '0839121d20003a190a1270726f7669646572537461747573436f64651203343030',
  'hex',
)
  .toString('base64')
  .replace(/=+$/u, '');
const exactRepeatedOuterFieldValue = Buffer.from(
  '0839121d20003a190a1270726f7669646572537461747573436f646512033430301200',
  'hex',
)
  .toString('base64')
  .replace(/=+$/u, '');

function customDetailsMessage(providerStatusCode: string, retryable: boolean): Buffer {
  const statusKey = Buffer.from('providerStatusCode');
  const statusValue = Buffer.from(providerStatusCode);
  const mapEntry = Buffer.concat([
    Buffer.from([0x0a, statusKey.length]),
    statusKey,
    Buffer.from([0x12, statusValue.length]),
    statusValue,
  ]);
  return Buffer.concat([
    Buffer.from([0x20, retryable ? 0x01 : 0x00]),
    Buffer.from([0x3a, mapEntry.length]),
    mapEntry,
  ]);
}

function outerProviderDetailValue(messages: readonly Buffer[]): string {
  return Buffer.concat([
    Buffer.from([0x08, 0x39]),
    ...messages.flatMap((message) => [Buffer.from([0x12, message.length]), message]),
  ])
    .toString('base64')
    .replace(/=+$/u, '');
}

describe('Cursor provider error policy', () => {
  it('preserves single-message defaults and rejects the exact repeated detail', () => {
    expect(decodeProviderErrorValue(exactSingleOuterFieldValue)).toEqual({
      errorNumber: 57,
      permanent: false,
      errorType: 'ERROR_PROVIDER_ERROR',
      retryable: false,
      providerStatusCode: '400',
    });

    const singleError = new ConnectRpcError(
      'Provider Error',
      'resource_exhausted',
      [{ type: 'aiserver.v1.ErrorDetails', value: exactSingleOuterFieldValue }],
      true,
    );
    expect(inspectCursorProviderError(singleError)).toMatchObject({
      providerError: true,
      retryProvider5xx: false,
    });
    expect({
      defaultPolicy: cursorRetryFailureKind(singleError),
      optInPolicy: cursorRetryFailureKind(singleError, { retryProvider5xx: true }),
    }).toEqual({ defaultPolicy: undefined, optInPolicy: undefined });

    expect(decodeProviderErrorValue(exactRepeatedOuterFieldValue)).toBeUndefined();
    const repeatedError = new ConnectRpcError(
      'Provider Error',
      'resource_exhausted',
      [{ type: 'aiserver.v1.ErrorDetails', value: exactRepeatedOuterFieldValue }],
      true,
    );
    expect(inspectCursorProviderError(repeatedError)).toMatchObject({
      retryProvider5xx: false,
      nonProviderNonRetryable: true,
    });
    expect({
      defaultPolicy: cursorRetryFailureKind(repeatedError),
      optInPolicy: cursorRetryFailureKind(repeatedError, { retryProvider5xx: true }),
    }).toEqual({ defaultPolicy: undefined, optInPolicy: undefined });
  });

  it.each([
    [
      'empty first then valid',
      outerProviderDetailValue([Buffer.alloc(0), customDetailsMessage('400', false)]),
    ],
    [
      'valid then empty',
      outerProviderDetailValue([customDetailsMessage('400', false), Buffer.alloc(0)]),
    ],
    [
      'conflicting retry and status messages',
      outerProviderDetailValue([
        customDetailsMessage('503', false),
        customDetailsMessage('400', true),
      ]),
    ],
  ])('rejects duplicate outer messages: %s', (_caseName, value) => {
    expect(decodeProviderErrorValue(value)).toBeUndefined();

    const error = new ConnectRpcError(
      'Provider Error',
      'resource_exhausted',
      [{ type: 'aiserver.v1.ErrorDetails', value }],
      true,
    );
    expect(inspectCursorProviderError(error).nonProviderNonRetryable).toBe(true);
    expect(cursorRetryFailureKind(error)).toBeUndefined();
    expect(cursorRetryFailureKind(error, { retryProvider5xx: true })).toBeUndefined();
  });

  it('keeps explicit non-retryable provider errors terminal by default', () => {
    expect(cursorRetryFailureKind(providerError())).toBeUndefined();
  });

  it('does not let an outer transport wrapper override an inner provider veto', () => {
    const inner = new ConnectRpcError(
      'Provider Error',
      'resource_exhausted',
      [
        {
          type: 'aiserver.v1.ErrorDetails',
          value: canonicalProviderDetailValue('400'),
        },
      ],
      true,
    );
    const outer = Object.assign(new Error('socket closed', { cause: inner }), {
      code: 'ECONNRESET',
    });

    expect(cursorRetryFailureKind(outer)).toBeUndefined();
    expect(cursorRetryFailureKind(outer, { retryProvider5xx: true })).toBeUndefined();
  });

  it('does not let an outer transport wrapper override a nested provider HTTP denial', () => {
    const denial = new CursorApiHttpError(403, 'provider denied', 'ERROR_PROVIDER_ERROR');
    const wrappedDenial = Object.assign(new Error('socket closed', { cause: denial }), {
      code: 'ECONNRESET',
    });
    const server = new CursorApiHttpError(503, 'provider unavailable');
    const wrappedServer = Object.assign(new Error('socket closed', { cause: server }), {
      code: 'ECONNRESET',
    });
    const transport = Object.assign(new Error('socket closed'), { code: 'ECONNRESET' });
    const wrappedTransport = new Error('request failed', { cause: transport });

    expect(cursorRetryFailureKind(wrappedDenial)).toBeUndefined();
    expect(cursorRetryFailureKind(wrappedServer)).toBe('transport');
    expect(cursorRetryFailureKind(wrappedTransport)).toBe('transport');
  });

  it('allows the exact provider 5xx through the bounded opt-in policy', () => {
    const error = providerError('503');

    expect(cursorRetryFailureKind(error, { retryProvider5xx: true })).toBe('server');
    expect(cursorProviderErrorDiagnostics(error)).toEqual({
      connectCode: 'resource_exhausted',
      upstreamErrorType: 'ERROR_PROVIDER_ERROR',
      upstreamRetryable: false,
      providerStatusCode: '503',
    });
  });

  it('uses canonical protobuf value instead of optional debug fields', () => {
    const error = new ConnectRpcError(
      'Provider Error',
      'resource_exhausted',
      [
        {
          type: 'aiserver.v1.ErrorDetails',
          value: canonicalProviderDetailValue(),
        },
      ],
      true,
    );

    expect(cursorRetryFailureKind(error)).toBeUndefined();
    expect(cursorRetryFailureKind(error, { retryProvider5xx: true })).toBeUndefined();
    expect(cursorProviderErrorDiagnostics(error)).toEqual({
      connectCode: 'resource_exhausted',
      upstreamErrorType: 'ERROR_PROVIDER_ERROR',
      upstreamRetryable: false,
      providerStatusCode: '400',
    });
  });

  it('keeps permanent debug error types authoritative over the opt-in', () => {
    const error = providerError('503', [
      {
        type: 'aiserver.v1.ErrorDetails',
        debug: { error: 'ERROR_PRO_USER_USAGE_LIMIT', details: { isRetryable: false } },
      },
    ]);

    expect(cursorRetryFailureKind(error, { retryProvider5xx: true })).toBeUndefined();
  });

  it('fails closed when a canonical ErrorDetails value is malformed', () => {
    const error = new ConnectRpcError(
      'Provider Error',
      'resource_exhausted',
      [{ type: 'aiserver.v1.ErrorDetails', value: 'not/base64?' }],
      true,
    );

    expect(cursorRetryFailureKind(error, { retryProvider5xx: true })).toBeUndefined();
    expect(cursorProviderErrorDiagnostics(error)).toEqual({
      connectCode: 'resource_exhausted',
    });
  });

  it('fails closed on an unsupported wire type inside a nested provider map entry', () => {
    const error = new ConnectRpcError(
      'Provider Error',
      'resource_exhausted',
      [
        {
          type: 'aiserver.v1.ErrorDetails',
          value: malformedNestedMapEntryValue,
        },
      ],
      true,
    );

    expect(decodeProviderErrorValue(malformedNestedMapEntryValue)).toBeUndefined();
    expect(cursorRetryFailureKind(error, { retryProvider5xx: true })).toBeUndefined();
  });

  it('ignores unknown map keys without overwriting provider status', () => {
    const value = canonicalProviderDetailValueWithMapEntries([
      additionalInfoEntry('providerStatusCode', '503'),
      additionalInfoEntry('unrelatedStatus', '400'),
    ]);

    expect(decodeProviderErrorValue(value)).toEqual({
      errorNumber: 57,
      permanent: false,
      errorType: 'ERROR_PROVIDER_ERROR',
      retryable: false,
      providerStatusCode: '503',
    });
  });

  it('accepts omitted and default map fields without supplying provider status', () => {
    const value = canonicalProviderDetailValueWithMapEntries([
      additionalInfoEntry(),
      additionalInfoEntry('', ''),
      additionalInfoEntry('providerStatusCode'),
      additionalInfoEntry(undefined, '503'),
    ]);

    expect(decodeProviderErrorValue(value)).toEqual({
      errorNumber: 57,
      permanent: false,
      errorType: 'ERROR_PROVIDER_ERROR',
      retryable: false,
    });
  });

  it('omits unbounded Connect codes and preserves bounded Run IDs', () => {
    const error = providerError();
    Object.defineProperty(error, 'code', { configurable: true, value: `x${'a'.repeat(96)}` });
    error.runRequestId = 'run-timeout-123';

    expect(cursorProviderErrorDiagnostics(error)).toEqual({
      upstreamErrorType: 'ERROR_PROVIDER_ERROR',
      upstreamRetryable: false,
      providerStatusCode: '400',
      runRequestId: 'run-timeout-123',
    });
  });

  it('rejects protobuf tags that overflow the 32-bit wire format', () => {
    const canonical = Buffer.from(canonicalProviderDetailValue('503'), 'base64');
    const malformed = Buffer.concat([
      Buffer.from([0x88, 0x80, 0x80, 0x80, 0x10]),
      canonical.subarray(1),
    ]);

    expect(decodeProviderErrorValue(malformed.toString('base64'))).toBeUndefined();
  });

  it('does not borrow a provider status from an unrelated detail', () => {
    const error = new ConnectRpcError(
      'Provider Error',
      'resource_exhausted',
      [
        {
          type: 'aiserver.v1.ErrorDetails',
          debug: {
            error: 'ERROR_PROVIDER_ERROR',
            details: { isRetryable: false },
          },
        },
        {
          type: 'aiserver.v1.ErrorDetails',
          debug: {
            error: 'ERROR_INTERNAL',
            details: {
              isRetryable: true,
              additionalInfo: { providerStatusCode: '503' },
            },
          },
        },
      ],
      true,
    );

    expect(cursorRetryFailureKind(error, { retryProvider5xx: true })).toBeUndefined();
    expect(cursorProviderErrorDiagnostics(error)).toEqual({
      connectCode: 'resource_exhausted',
      upstreamErrorType: 'ERROR_PROVIDER_ERROR',
      upstreamRetryable: false,
    });
  });

  it('does not splice retry proof across provider details', () => {
    const error = new ConnectRpcError(
      'Provider Error',
      'resource_exhausted',
      [
        {
          type: 'aiserver.v1.ErrorDetails',
          debug: {
            error: 'ERROR_PROVIDER_ERROR',
            details: { isRetryable: false },
          },
        },
        {
          type: 'aiserver.v1.ErrorDetails',
          debug: {
            error: 'ERROR_PROVIDER_ERROR',
            details: { additionalInfo: { providerStatusCode: '503' } },
          },
        },
      ],
      true,
    );

    expect(cursorRetryFailureKind(error, { retryProvider5xx: true })).toBeUndefined();
  });

  it('fails closed when provider details disagree on status', () => {
    const detail = (providerStatusCode: string) => ({
      type: 'aiserver.v1.ErrorDetails',
      debug: {
        error: 'ERROR_PROVIDER_ERROR',
        details: {
          isRetryable: false,
          additionalInfo: { providerStatusCode },
        },
      },
    });
    const error = new ConnectRpcError(
      'Provider Error',
      'resource_exhausted',
      [detail('503'), detail('400')],
      true,
    );

    expect(cursorProviderErrorDiagnostics(error)?.providerStatusCode).toBeUndefined();
    expect(cursorRetryFailureKind(error, { retryProvider5xx: true })).toBeUndefined();
  });

  it('does not let the header mask an authoritative permanent enum', () => {
    const error = new ConnectRpcError(
      'Usage limit',
      'resource_exhausted',
      [
        {
          type: 'aiserver.v1.ErrorDetails',
          value: canonicalProviderDetailValue('503', 10),
        },
      ],
      true,
    );
    error.inferenceErrorType = 'ERROR_PROVIDER_ERROR';

    expect(cursorRetryFailureKind(error, { retryProvider5xx: true })).toBeUndefined();
    expect(cursorProviderErrorDiagnostics(error)).toEqual({
      connectCode: 'resource_exhausted',
    });
  });

  it.each(['GARBAGE', 10])(
    'does not let the header mask malformed debug error %j',
    (debugError) => {
      const error = new ConnectRpcError(
        'Provider Error',
        'resource_exhausted',
        [
          {
            type: 'aiserver.v1.ErrorDetails',
            debug: {
              error: debugError,
              details: {
                isRetryable: false,
                additionalInfo: { providerStatusCode: '503' },
              },
            },
          },
        ],
        true,
      );
      error.inferenceErrorType = 'ERROR_PROVIDER_ERROR';

      expect(cursorRetryFailureKind(error, { retryProvider5xx: true })).toBeUndefined();
    },
  );

  it('fails closed on mixed authoritative retry markers with the same status', () => {
    const detail = (retryable: boolean) => ({
      type: 'aiserver.v1.ErrorDetails',
      value: canonicalProviderDetailValueWithRetryable('503', retryable),
    });
    const error = new ConnectRpcError(
      'Provider Error',
      'resource_exhausted',
      [detail(false), detail(true)],
      true,
    );

    expect(inspectCursorProviderError(error).retryProvider5xx).toBe(false);
    expect(cursorProviderErrorDiagnostics(error)).toEqual({
      connectCode: 'resource_exhausted',
      upstreamErrorType: 'ERROR_PROVIDER_ERROR',
      providerStatusCode: '503',
    });
    expect(cursorRetryFailureKind(error, { retryProvider5xx: true })).toBeUndefined();
    expect(cursorRetryFailureKind(providerError('503'), { retryProvider5xx: true })).toBe('server');
  });

  it('keeps a permanent enum authoritative without a retry marker', () => {
    const error = providerError('503', [
      {
        type: 'aiserver.v1.ErrorDetails',
        value: Buffer.from([0x08, 0x0a]).toString('base64').replace(/=+$/u, ''),
      },
    ]);

    expect(cursorRetryFailureKind(error, { retryProvider5xx: true })).toBeUndefined();
  });

  it('does not auth-failover a decoded permanent enum', () => {
    const error = new ConnectRpcError(
      'Usage limit',
      'unauthenticated',
      [
        {
          type: 'aiserver.v1.ErrorDetails',
          value: Buffer.from([0x08, 0x0a]).toString('base64').replace(/=+$/u, ''),
        },
      ],
      true,
    );
    error.inferenceErrorType = 'ERROR_PROVIDER_ERROR';

    expect(isCredentialAuthFailure(error)).toBe(false);
  });

  it('does not override a non-server Connect code with the experiment', () => {
    const error = new ConnectRpcError(
      'Provider Error',
      'permission_denied',
      providerDetails('503'),
      true,
    );

    expect(cursorRetryFailureKind(error, { retryProvider5xx: true })).toBeUndefined();
  });

  it('redacts untrusted provider messages and raw details', () => {
    const error = new ConnectRpcError(
      'upstream body sk-provider-SECRET',
      'resource_exhausted',
      providerDetails(),
      true,
    );

    expect(JSON.stringify(safeCursorBackendError(error))).not.toContain('sk-provider-SECRET');
    expect(JSON.stringify(safeCursorBackendError(error))).not.toContain('SECRET_PROVIDER_VALUE');
  });

  it('redacts permanent Connect errors even when provider diagnostics are suppressed', () => {
    const error = new ConnectRpcError(
      'provider secret sk-live-PERMANENT',
      'resource_exhausted',
      [{ type: 'aiserver.v1.ErrorDetails', value: 'CAo' }],
      true,
    );
    error.inferenceErrorType = 'ERROR_PROVIDER_ERROR';

    expect(JSON.stringify(safeCursorBackendError(error))).not.toContain('sk-live-PERMANENT');
  });

  it('redacts wrapped permanent Connect errors', () => {
    const inner = new ConnectRpcError(
      'sk-inner-PERMANENT',
      'resource_exhausted',
      [
        {
          type: 'aiserver.v1.ErrorDetails',
          debug: {
            error: 'ERROR_PRO_USER_USAGE_LIMIT',
            details: { isRetryable: false },
          },
        },
      ],
      true,
    );
    const outer = new Error('wrapped sk-outer-PERMANENT', { cause: inner });

    expect(JSON.stringify(safeCursorBackendError(outer))).not.toContain('PERMANENT');
  });
});
