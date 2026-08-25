import { describe, expect, it } from 'vitest';
import { ConnectRpcError, encodeConnectFrame } from '../src/backend/cursor-api/connect-frame.js';
import { safeCursorBackendError } from '../src/backend/cursor-api/provider-error.js';
import { CursorRunTimeoutError } from '../src/backend/cursor-api/run-errors.js';
import type { ChatCompletionRequest } from '../src/backend/types.js';
import type { BridgeConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { attachRequestTrace, createRequestTrace, type TraceRecord } from '../src/trace.js';
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

function tracedProviderRequest(records: TraceRecord[]): ChatCompletionRequest {
  const candidate = structuredClone(providerRequest);
  const trace = createRequestTrace({
    environment: { CURSOR_BRIDGE_TRACE: '1' },
    requestId: 'chatcmpl-provider-retry-telemetry',
    model: providerRequest.model,
    sink: (record) => records.push(record),
  });
  if (!trace) throw new Error('expected tracing to be enabled');
  attachRequestTrace(candidate, trace);
  return candidate;
}

function runTimeoutError(): CursorRunTimeoutError {
  return new CursorRunTimeoutError('Cursor API run timed out after 1ms', 'run-timeout-1', {
    phase: 'awaiting_upstream',
    toolResultsSent: 0,
    bufferedFrames: 0,
    streamState: { destroyed: false, writableEnded: false },
    toolCallsAnnounced: 0,
    toolCallsCompleted: 0,
    lastInteractionCase: null,
    lastInteractionAgoMs: 0,
    outputBytes: 0,
    decodedOutputBytes: 0,
    sawTurnEnded: false,
    sawTrailer: false,
    transport: {},
  });
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

  it('fails over a provider 503 before the same-credential retry loop when configured', async () => {
    const records: TraceRecord[] = [];
    const transport = new ScriptedTransport((stream) => {
      stream.emit('response', { ':status': 200 });
      stream.emit(
        'data',
        transport.opened.at(-1)?.accessToken === 'key-a'
          ? providerErrorTrailer('503')
          : Buffer.concat([update('textDelta', { text: 'recovered on b' }), trailer()]),
      );
    });
    const cursor = backend(
      transport,
      [
        { id: 'a', apiKey: 'key-a' },
        { id: 'b', apiKey: 'key-b' },
      ],
      { CURSOR_BRIDGE_FAILOVER_ON: 'auth_or_quota_or_5xx' },
    );

    await expect(cursor.complete(tracedProviderRequest(records))).resolves.toMatchObject({
      content: 'recovered on b',
    });
    expect(transport.opened.map((run) => run.accessToken)).toEqual(['key-a', 'key-b']);
    expect(cursor.credentialStates()[0]).toMatchObject({
      disabledReason: 'cooldown',
    });
    expect(records.find((record) => record.stage === 'credential_failover')).toMatchObject({
      credential_exclusion_reason: 'cooldown',
    });
    expect(JSON.stringify(records)).not.toMatch(/"a"|"b"|key-a|key-b/u);
  });

  it('fails over a value-only usage limit as billing when configured', async () => {
    const records: TraceRecord[] = [];
    const quotaFailure = new ConnectRpcError(
      'Usage limit',
      'resource_exhausted',
      [
        {
          type: 'aiserver.v1.ErrorDetails',
          value: canonicalProviderDetailValue('400', 10),
        },
      ],
      true,
    );
    const transport = new ScriptedTransport((stream) => {
      if (transport.opened.at(-1)?.accessToken === 'key-a') {
        stream.emit('error', quotaFailure);
        return;
      }
      stream.emit('response', { ':status': 200 });
      stream.emit(
        'data',
        Buffer.concat([update('textDelta', { text: 'quota recovered on b' }), trailer()]),
      );
    });
    const cursor = backend(
      transport,
      [
        { id: 'a', apiKey: 'key-a' },
        { id: 'b', apiKey: 'key-b' },
      ],
      { CURSOR_BRIDGE_FAILOVER_ON: 'auth_or_quota' },
    );

    await expect(cursor.complete(tracedProviderRequest(records))).resolves.toMatchObject({
      content: 'quota recovered on b',
    });
    expect(transport.opened.map((run) => run.accessToken)).toEqual(['key-a', 'key-b']);
    expect(cursor.credentialStates()[0]).toMatchObject({
      disabledReason: 'billing',
    });
    const failover = records.find((record) => record.stage === 'credential_failover');
    expect(failover).toMatchObject({
      credential_exclusion_reason: 'billing',
    });
    expect(failover?.excluded_credential_slot_id).toMatch(/^slot_[0-9a-f]{16}$/u);
    expect(failover?.next_credential_slot_id).toMatch(/^slot_[0-9a-f]{16}$/u);
    expect(failover?.next_credential_slot_id).not.toBe(failover?.excluded_credential_slot_id);
    expect(JSON.stringify(records)).not.toMatch(/"a"|"b"|key-a|key-b/u);
  });

  it('keeps a provider 503 on the first credential under the auth default', async () => {
    const transport = new ScriptedTransport((stream) => {
      stream.emit('response', { ':status': 200 });
      stream.emit('data', providerErrorTrailer('503'));
    });
    const cursor = backend(transport, [
      { id: 'a', apiKey: 'key-a' },
      { id: 'b', apiKey: 'key-b' },
    ]);

    await expect(cursor.complete(providerRequest)).rejects.toMatchObject({
      code: 'resource_exhausted',
    });
    expect(transport.opened.map((run) => run.accessToken)).toEqual(['key-a']);
    expect(cursor.credentialStates().some((state) => state.disabledReason !== undefined)).toBe(
      false,
    );
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
      CURSOR_BRIDGE_FAILOVER_ON: 'auth_or_quota_or_5xx',
    });
    const events: unknown[] = [];

    await expect(async () => {
      for await (const event of cursor.completeStream(providerRequest)) events.push(event);
    }).rejects.toMatchObject({ code: 'resource_exhausted' });
    expect(events).toContainEqual({ type: 'content', text: 'visible' });
    expect(transport.opened).toHaveLength(1);
  });

  it('records the flag-off decline for an eligible provider 503 without the opt-in', async () => {
    const records: TraceRecord[] = [];
    const transport = new ScriptedTransport((stream) => {
      stream.emit('response', { ':status': 200 });
      stream.emit('data', providerErrorTrailer('503'));
    });

    await expect(backend(transport).complete(tracedProviderRequest(records))).rejects.toMatchObject(
      { code: 'resource_exhausted' },
    );

    expect(transport.opened).toHaveLength(1);
    expect(records.filter((record) => record.stage === 'retry')).toHaveLength(0);
    expect(records.filter((record) => record.stage === 'upstream_error')).toHaveLength(1);
    expect(records.find((record) => record.stage === 'upstream_error')).toMatchObject({
      provider_status_code: '503',
      upstream_retryable: false,
      retry_provider_5xx: false,
      retry_declined: 'flag_off',
    });
    expect(JSON.stringify(records)).not.toContain('SECRET_PROVIDER_VALUE');
  });

  it('records the post-visible decline for an opted-in provider 5xx after client-visible output', async () => {
    const records: TraceRecord[] = [];
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
      for await (const event of cursor.completeStream(tracedProviderRequest(records)))
        events.push(event);
    }).rejects.toMatchObject({ code: 'resource_exhausted' });

    expect(events).toContainEqual({ type: 'content', text: 'visible' });
    expect(transport.opened).toHaveLength(1);
    expect(records.find((record) => record.stage === 'upstream_error')).toMatchObject({
      retry_provider_5xx: true,
      retry_declined: 'post_visible',
      provider_status_code: '503',
    });
    expect(records.filter((record) => record.stage === 'retry')).toHaveLength(0);
  });

  it('records the retry-limit decline after three provider 5xx retries', async () => {
    const records: TraceRecord[] = [];
    const transport = new ScriptedTransport((stream) => {
      stream.emit('response', { ':status': 200 });
      stream.emit('data', providerErrorTrailer('503'));
    });

    await expect(
      backend(transport, undefined, { CURSOR_BRIDGE_RETRY_PROVIDER_5XX: '1' }).complete(
        tracedProviderRequest(records),
      ),
    ).rejects.toMatchObject({ code: 'resource_exhausted' });

    expect(transport.opened).toHaveLength(4);
    const retries = records.filter((record) => record.stage === 'retry');
    expect(retries).toHaveLength(3);
    expect(
      retries.every(
        (record) => record.retry_kind === 'server' && record.retry_reason === 'provider_5xx',
      ),
    ).toBe(true);
    const upstreamErrors = records.filter((record) => record.stage === 'upstream_error');
    expect(upstreamErrors).toHaveLength(4);
    expect(upstreamErrors.slice(0, 3).every((record) => record.retry_declined === undefined)).toBe(
      true,
    );
    expect(upstreamErrors.at(-1)).toMatchObject({
      retry_declined: 'retry_limit',
      provider_status_code: '503',
    });
    expect(JSON.stringify(records)).not.toContain('SECRET_PROVIDER_VALUE');
  });

  it('self-describes an actual provider 5xx retry with a pinned credential and per-attempt run ids', async () => {
    const records: TraceRecord[] = [];
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
      [{ id: 'pin-credential-source', apiKey: 'pin-token-secret' }],
      { CURSOR_BRIDGE_RETRY_PROVIDER_5XX: '1' },
    );

    await expect(cursor.complete(tracedProviderRequest(records))).resolves.toMatchObject({
      content: 'recovered',
    });

    const runOpens = records.filter((record) => record.stage === 'run_open');
    expect(runOpens).toHaveLength(2);
    const runRequestIds = runOpens.map((record) => record.run_request_id);
    expect(new Set(runRequestIds).size).toBe(2);
    expect(runRequestIds.every((id) => typeof id === 'string' && id.length <= 96)).toBe(true);
    const slots = runOpens.map((record) => record.credential_slot_id);
    if (slots[0] === null || slots[0] === undefined) throw new Error('missing slot on first run');
    if (slots[1] === null || slots[1] === undefined) throw new Error('missing slot on second run');
    expect(slots[0]).toMatch(/^slot_[0-9a-f]{16}$/u);
    expect(slots[1]).toBe(slots[0]);
    expect(records.find((record) => record.stage === 'retry')).toMatchObject({
      retry_kind: 'server',
      retry_reason: 'provider_5xx',
      retry_provider_5xx: true,
    });
    expect(
      records.every(
        (record) => record.retry_provider_5xx === undefined || record.retry_provider_5xx === true,
      ),
    ).toBe(true);
    expect(JSON.stringify(records)).not.toMatch(/pin-credential-source|pin-token-secret/);
  });

  it('marks an opt-in run timeout retry with the run_timeout reason', async () => {
    const records: TraceRecord[] = [];
    const transport = new ScriptedTransport((stream) => {
      stream.emit('response', { ':status': 200 });
      if (transport.opened.length === 1) {
        stream.emit('error', runTimeoutError());
        return;
      }
      stream.emit(
        'data',
        Buffer.concat([update('textDelta', { text: 'after timeout' }), trailer()]),
      );
    });

    await expect(
      backend(transport, undefined, { CURSOR_BRIDGE_RETRY_RUN_TIMEOUT: '1' }).complete(
        tracedProviderRequest(records),
      ),
    ).resolves.toMatchObject({ content: 'after timeout' });

    expect(transport.opened).toHaveLength(2);
    expect(records.find((record) => record.stage === 'retry')).toMatchObject({
      retry_kind: 'transport',
      retry_reason: 'run_timeout',
      retry_provider_5xx: false,
    });
    expect(records.find((record) => record.stage === 'upstream_error')).toMatchObject({
      run_request_id: 'run-timeout-1',
    });
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
