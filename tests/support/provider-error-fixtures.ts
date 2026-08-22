import { ConnectRpcError, encodeConnectFrame } from '../../src/backend/cursor-api/connect-frame.js';
import type { ChatCompletionRequest } from '../../src/backend/types.js';

export const providerRequest: ChatCompletionRequest = {
  model: 'composer-2.5',
  messages: [{ role: 'user', content: 'answer once' }],
};

export function providerDetails(
  providerStatusCode = '400',
  additionalDetails: readonly unknown[] = [],
): unknown[] {
  return [
    {
      type: 'aiserver.v1.ErrorDetails',
      debug: {
        error: 'ERROR_PROVIDER_ERROR',
        details: {
          title: 'Provider Error',
          detail:
            "We're having trouble connecting to the model provider. This might be temporary - please try again in a moment.",
          isRetryable: false,
          additionalInfo: {
            providerStatusCode,
            accessToken: 'SECRET_PROVIDER_VALUE',
          },
        },
      },
    },
    ...additionalDetails,
  ];
}

export function providerError(
  providerStatusCode = '400',
  additionalDetails: readonly unknown[] = [],
): ConnectRpcError {
  return new ConnectRpcError(
    'Provider Error',
    'resource_exhausted',
    providerDetails(providerStatusCode, additionalDetails),
    true,
  );
}

export function canonicalProviderDetailValue(providerStatusCode = '400', errorNumber = 57): string {
  const statusKey = Buffer.from('providerStatusCode');
  const statusValue = Buffer.from(providerStatusCode);
  const mapEntry = Buffer.concat([
    Buffer.from([0x0a, statusKey.length]),
    statusKey,
    Buffer.from([0x12, statusValue.length]),
    statusValue,
  ]);
  const customDetails = Buffer.concat([
    Buffer.from([0x20, 0x00]),
    Buffer.from([0x3a, mapEntry.length]),
    mapEntry,
  ]);
  return Buffer.concat([
    Buffer.from([0x08, errorNumber]),
    Buffer.from([0x12, customDetails.length]),
    customDetails,
  ])
    .toString('base64')
    .replace(/=+$/u, '');
}

export function providerErrorTrailer(
  providerStatusCode = '400',
  code = 'resource_exhausted',
): Buffer {
  return encodeConnectFrame(
    Buffer.from(
      JSON.stringify({
        error: {
          code,
          message: 'Provider Error',
          details: providerDetails(providerStatusCode),
        },
      }),
    ),
    { trailer: true },
  );
}

export function canonicalProviderErrorTrailer(providerStatusCode = '400'): Buffer {
  return encodeConnectFrame(
    Buffer.from(
      JSON.stringify({
        error: {
          code: 'resource_exhausted',
          message: 'Provider Error',
          details: [
            {
              type: 'aiserver.v1.ErrorDetails',
              value: canonicalProviderDetailValue(providerStatusCode),
            },
          ],
        },
      }),
    ),
    { trailer: true },
  );
}

export function providerErrorTrailerWithoutType(providerStatusCode = '503'): Buffer {
  return encodeConnectFrame(
    Buffer.from(
      JSON.stringify({
        error: {
          code: 'resource_exhausted',
          message: 'Provider Error',
          details: [
            {
              type: 'aiserver.v1.ErrorDetails',
              debug: {
                details: {
                  isRetryable: false,
                  additionalInfo: { providerStatusCode },
                },
              },
            },
          ],
        },
      }),
    ),
    { trailer: true },
  );
}
