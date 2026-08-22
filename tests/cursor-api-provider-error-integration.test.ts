import { describe, expect, it } from 'vitest';
import { ConnectRpcError, encodeConnectFrame } from '../src/backend/cursor-api/connect-frame.js';
import { safeCursorBackendError } from '../src/backend/cursor-api/provider-error.js';
import type { BridgeConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import type { TraceRecord } from '../src/trace.js';
import { backend, ScriptedTransport, trailer, update } from './support/cursor-api-scripted.js';
import {
  canonicalProviderDetailValue,
  canonicalProviderErrorTrailer,
  providerError,
  providerErrorTrailer,
  providerErrorTrailerWithoutType,
  providerRequest,
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

const malformedNestedMapEntryValue = Buffer.from(
  '0839122020003a190a1270726f7669646572537461747573436f646512033530333a010f',
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

function exactRepeatedProviderErrorTrailer(): Buffer {
  return encodeConnectFrame(
    Buffer.from(
      JSON.stringify({
        error: {
          code: 'resource_exhausted',
          message: 'Provider Error',
          details: [{ type: 'aiserver.v1.ErrorDetails', value: exactRepeatedOuterFieldValue }],
        },
      }),
    ),
    { trailer: true },
  );
}

function malformedProviderErrorTrailer(): Buffer {
  return encodeConnectFrame(
    Buffer.from(
      JSON.stringify({
        error: {
          code: 'resource_exhausted',
          message: 'Provider Error',
          details: [
            {
              type: 'aiserver.v1.ErrorDetails',
              value: malformedNestedMapEntryValue,
            },
          ],
        },
      }),
    ),
    { trailer: true },
  );
}

describe('Cursor provider error integration', () => {
  it('attempts the exact repeated outer detail only once with the opt-in', async () => {
    const transport = new ScriptedTransport((stream) => {
      stream.emit('response', { ':status': 200 });
      stream.emit('data', exactRepeatedProviderErrorTrailer());
    });

    await expect(
      backend(transport, undefined, { CURSOR_BRIDGE_RETRY_PROVIDER_5XX: '1' }).complete(
        providerRequest,
      ),
    ).rejects.toMatchObject({ code: 'resource_exhausted' });
    expect(transport.opened).toHaveLength(1);
  });

  it('recovers before visible output on one credential when opted in', async () => {
    const transport = new ScriptedTransport((stream) => {
      stream.emit('response', { ':status': 200 });
      stream.emit(
        'data',
        transport.opened.length === 1
          ? providerErrorTrailer('503')
          : Buffer.concat([update('textDelta', { text: 'recovered' }), trailer()]),
      );
    });
    const cursor = backend(
      transport,
      [
        { id: 'a', apiKey: 'key-a' },
        { id: 'b', apiKey: 'key-b' },
      ],
      { CURSOR_BRIDGE_RETRY_PROVIDER_5XX: '1' },
    );

    await expect(cursor.complete(providerRequest)).resolves.toMatchObject({
      content: 'recovered',
    });
    expect(transport.opened.map((run) => run.accessToken)).toEqual(['key-a', 'key-a']);
  });

  it('preserves the inference error type response header', async () => {
    const transport = new ScriptedTransport((stream) => {
      stream.emit('response', {
        ':status': 200,
        'x-cursor-inference-request-error-type': 'ERROR_PROVIDER_ERROR',
      });
      stream.emit(
        'data',
        transport.opened.length === 1
          ? providerErrorTrailerWithoutType()
          : Buffer.concat([update('textDelta', { text: 'header recovery' }), trailer()]),
      );
    });

    await expect(
      backend(transport, undefined, {
        CURSOR_BRIDGE_RETRY_PROVIDER_5XX: '1',
      }).complete(providerRequest),
    ).resolves.toMatchObject({ content: 'header recovery' });
    expect(transport.opened).toHaveLength(2);
  });

  it('does not retry the same provider error without the opt-in', async () => {
    const transport = new ScriptedTransport((stream) => {
      stream.emit('response', { ':status': 200 });
      stream.emit('data', providerErrorTrailer());
    });

    await expect(backend(transport).complete(providerRequest)).rejects.toMatchObject({
      code: 'resource_exhausted',
    });
    expect(transport.opened).toHaveLength(1);
  });

  it('does not retry a malformed nested provider map entry with the 5xx opt-in', async () => {
    const transport = new ScriptedTransport((stream) => {
      stream.emit('response', { ':status': 200 });
      stream.emit('data', malformedProviderErrorTrailer());
    });

    await expect(
      backend(transport, undefined, { CURSOR_BRIDGE_RETRY_PROVIDER_5XX: '1' }).complete(
        providerRequest,
      ),
    ).rejects.toMatchObject({ code: 'resource_exhausted' });
    expect(transport.opened).toHaveLength(1);
  });

  it('does not transport-replay a wrapped provider 400 failure', async () => {
    const transport = new ScriptedTransport((stream) => {
      stream.emit('response', { ':status': 200 });
      stream.emit(
        'error',
        Object.assign(new Error('socket closed', { cause: providerError('400') }), {
          code: 'ECONNRESET',
        }),
      );
    });

    await expect(
      backend(transport, undefined, { CURSOR_BRIDGE_RETRY_PROVIDER_5XX: '1' }).complete(
        providerRequest,
      ),
    ).rejects.toMatchObject({ code: 'ECONNRESET' });
    expect(transport.opened).toHaveLength(1);
  });

  it('does not replay mixed provider retry markers', async () => {
    const mixedFailure = new ConnectRpcError(
      'Provider Error',
      'resource_exhausted',
      [
        {
          type: 'aiserver.v1.ErrorDetails',
          value: canonicalProviderDetailValueWithRetryable('503', false),
        },
        {
          type: 'aiserver.v1.ErrorDetails',
          value: canonicalProviderDetailValueWithRetryable('503', true),
        },
      ],
      true,
    );
    const transport = new ScriptedTransport((stream) => {
      stream.emit('response', { ':status': 200 });
      stream.emit('error', mixedFailure);
    });

    await expect(
      backend(transport, undefined, { CURSOR_BRIDGE_RETRY_PROVIDER_5XX: '1' }).complete(
        providerRequest,
      ),
    ).rejects.toBe(mixedFailure);
    expect(transport.opened).toHaveLength(1);
  });

  it('does not rotate credentials for provider-shaped permission failures', async () => {
    const transport = new ScriptedTransport((stream) => {
      stream.emit('response', { ':status': 200 });
      stream.emit('data', providerErrorTrailer('400', 'permission_denied'));
    });
    const cursor = backend(transport, [
      { id: 'a', apiKey: 'key-a' },
      { id: 'b', apiKey: 'key-b' },
    ]);

    await expect(cursor.complete(providerRequest)).rejects.toMatchObject({
      code: 'permission_denied',
    });
    expect(transport.opened.map((run) => run.accessToken)).toEqual(['key-a']);
  });

  it('does not rotate credentials for typed provider HTTP 403', async () => {
    const transport = new ScriptedTransport((stream) => {
      stream.emit('response', {
        ':status': 403,
        'x-cursor-inference-request-error-type': 'ERROR_PROVIDER_ERROR',
      });
    });
    const cursor = backend(transport, [
      { id: 'a', apiKey: 'key-a' },
      { id: 'b', apiKey: 'key-b' },
    ]);

    await expect(cursor.complete(providerRequest)).rejects.toMatchObject({ status: 403 });
    expect(transport.opened.map((run) => run.accessToken)).toEqual(['key-a']);
    expect(cursor.credentialStates().some((state) => state.disabledReason === 'auth')).toBe(false);
  });

  it('does not replay an opted-in provider 5xx after visible output', async () => {
    const transport = new ScriptedTransport((stream) => {
      stream.emit('response', { ':status': 200 });
      stream.emit(
        'data',
        Buffer.concat([update('textDelta', { text: 'visible' }), providerErrorTrailer('503')]),
      );
    });
    const cursor = backend(transport, undefined, {
      CURSOR_BRIDGE_RETRY_PROVIDER_5XX: '1',
    });
    const events: unknown[] = [];

    await expect(async () => {
      for await (const event of cursor.completeStream(providerRequest)) events.push(event);
    }).rejects.toMatchObject({ code: 'resource_exhausted' });
    expect(events).toContainEqual({ type: 'content', text: 'visible' });
    expect(transport.opened).toHaveLength(1);
  });

  it('decodes canonical value-only details before declining retry', async () => {
    const transport = new ScriptedTransport((stream) => {
      stream.emit('response', { ':status': 200 });
      stream.emit('data', canonicalProviderErrorTrailer());
    });

    await expect(backend(transport).complete(providerRequest)).rejects.toMatchObject({
      code: 'resource_exhausted',
    });
    expect(transport.opened).toHaveLength(1);
  });

  it('returns allowlisted diagnostics without raw provider details', async () => {
    const config: BridgeConfig = {
      host: '127.0.0.1',
      port: 0,
      apiKey: 'client-key',
      clientAuth: 'on',
      backend: 'cursor-api',
      defaultModel: 'composer-2.5',
      workspaceMode: 'chat-only',
      version: 'test',
    };
    const transport = new ScriptedTransport((stream) => {
      stream.emit('response', { ':status': 200 });
      stream.emit('data', providerErrorTrailer());
    });
    const records: TraceRecord[] = [];
    const server = await buildServer({
      config,
      backend: backend(transport),
      trace: {
        environment: { CURSOR_BRIDGE_TRACE: '1' },
        sink: (record) => records.push(record),
      },
    });

    try {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: 'Bearer client-key',
          'content-type': 'application/json',
        },
        payload: providerRequest,
      });
      const body = response.json();

      expect(response.statusCode).toBe(502);
      expect(body.error.request_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      );
      expect(body.error.details).toEqual({
        connect_code: 'resource_exhausted',
        upstream_error_type: 'ERROR_PROVIDER_ERROR',
        upstream_retryable: false,
        provider_status_code: '400',
      });
      expect(records.find((record) => record.stage === 'upstream_error')).toMatchObject({
        upstream_error_code: 'resource_exhausted',
        upstream_error_type: 'ERROR_PROVIDER_ERROR',
        upstream_retryable: false,
        provider_status_code: '400',
        run_request_id: body.error.request_id,
      });
      expect(JSON.stringify(body)).not.toContain('SECRET_PROVIDER_VALUE');
      expect(JSON.stringify(safeCursorBackendError(providerError()))).not.toContain(
        'SECRET_PROVIDER_VALUE',
      );
    } finally {
      await server.close();
    }
  });
});
