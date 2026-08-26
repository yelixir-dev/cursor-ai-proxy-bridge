import { describe, expect, it, vi } from 'vitest';
import {
  AutoCursorBackend,
  createConfiguredBackend,
  type ProbeableCursorApiBackend,
} from '../src/backend/auto.js';
import { errorText } from '../src/backend/auto-runtime.js';
import { ConnectRpcError } from '../src/backend/cursor-api/connect-frame.js';
import { CursorApiHttpError } from '../src/backend/cursor-api/transport.js';
import type {
  BackendHealth,
  ChatCompletionRequest,
  CompletionResult,
  CompletionStreamEvent,
  CursorBackend,
} from '../src/backend/types.js';
import type { BridgeConfig } from '../src/config.js';
import { providerDetails } from './support/provider-error-fixtures.js';

const config: BridgeConfig = {
  host: '127.0.0.1',
  port: 9997,
  backend: 'auto',
  defaultModel: 'composer-2.5',
  workspaceMode: 'chat-only',
  version: 'test',
};
const request: ChatCompletionRequest = {
  model: 'composer-2.5',
  messages: [{ role: 'user', content: 'hello' }],
};

function backend(type: string, complete?: () => Promise<CompletionResult>): CursorBackend {
  return {
    type,
    health: async (): Promise<BackendHealth> => ({
      ok: true,
      type,
      authConfigured: true,
    }),
    listModels: async () => [],
    complete:
      complete ??
      (async () => ({
        content: type,
        model: 'composer-2.5',
      })),
    completeStream: async function* (): AsyncIterable<CompletionStreamEvent> {
      yield {
        type: 'done',
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        is_error: false,
      };
    },
  };
}

function api(
  options: {
    initialize?: () => Promise<void>;
    probe?: () => Promise<void>;
    complete?: () => Promise<CompletionResult>;
  } = {},
): ProbeableCursorApiBackend {
  return {
    ...backend('cursor-api', options.complete),
    initialize: options.initialize ?? (async () => undefined),
    probe: options.probe ?? (async () => undefined),
  };
}

async function selected(options: {
  mode?: BridgeConfig['backend'];
  apiFactory?: () => ProbeableCursorApiBackend;
  binary?: string;
}) {
  return createConfiguredBackend(
    { ...config, backend: options.mode ?? 'auto' },
    {
      createApi: options.apiFactory ?? (() => api()),
      createCli: () => backend('cursor-cli'),
      findCliBinary: () => options.binary,
    },
  );
}

describe('automatic backend selection', () => {
  it.each([
    ['descriptors missing', () => Promise.reject(new Error('descriptors missing'))],
    ['auth missing', () => Promise.reject(new Error('authentication unavailable'))],
    ['probe failed', () => Promise.reject(new Error('GetServerConfig failed'))],
  ])('falls back to cursor-cli when cursor-api %s', async (_name, initialize) => {
    const result = await selected({
      apiFactory: () => api({ initialize }),
      binary: '/test/cursor-agent',
    });
    expect((await result.health()).activeBackend).toBe('cursor-cli');
  });

  it('uses cursor-api without fallback when the binary is missing', async () => {
    const result = await selected({ binary: undefined });
    const health = await result.health();
    expect(health.activeBackend).toBe('cursor-api');
    expect(health.fallbackAvailable).toBe(false);
  });

  it('fails startup actionably when neither backend is usable', async () => {
    await expect(
      selected({
        apiFactory: () => {
          throw new Error('descriptors missing');
        },
      }),
    ).rejects.toThrow(/Tried cursor-api.*cursor-cli.*CURSOR_BRIDGE_CURSOR_BIN/);
  });

  it('forced modes never select the other backend', async () => {
    const forcedApi = await selected({ mode: 'cursor-api', binary: '/test/cursor-agent' });
    expect(forcedApi.type).toBe('cursor-api');
    const forcedCli = await selected({ mode: 'cursor-cli', binary: '/test/cursor-agent' });
    expect(forcedCli.type).toBe('cursor-cli');
  });
});

describe('automatic backend runtime failover', () => {
  it('forwards credential policy state and hot updates while the CLI fallback is active', () => {
    const initialPolicy = {
      routingPolicy: 'round_robin',
      failoverOn: 'auth_or_quota',
    } as const;
    const updateCredentialPolicy = vi.fn();
    const direct = {
      ...api(),
      credentialPolicy: () => initialPolicy,
      updateCredentialPolicy,
    };
    const automatic = new AutoCursorBackend(direct, backend('cursor-cli'), {
      now: () => 1_000,
      warn: () => undefined,
      cooldownMs: 100,
      fatalThreshold: 3,
      probeTimeoutMs: 10,
      initial: 'cursor-cli',
    });
    const nextPolicy = {
      routingPolicy: 'weighted_round_robin',
      failoverOn: 'auth_or_quota_or_5xx',
    } as const;

    expect(automatic.credentialPolicy()).toEqual(initialPolicy);
    automatic.updateCredentialPolicy(nextPolicy);
    expect(updateCredentialPolicy).toHaveBeenCalledExactlyOnceWith(nextPolicy);
  });

  it('flips after repeated transport failures, cools down, and recovers on a probe', async () => {
    let now = 1_000;
    let failures = 3;
    const probe = vi.fn(async () => undefined);
    const warnings: string[] = [];
    const direct = api({
      probe,
      complete: async () => {
        if (failures-- > 0) throw Object.assign(new Error('socket reset'), { code: 'ECONNRESET' });
        return { content: 'api', model: 'composer-2.5' };
      },
    });
    const fallback = backend('cursor-cli');
    const automatic = new AutoCursorBackend(direct, fallback, {
      now: () => now,
      warn: (message) => warnings.push(message),
      cooldownMs: 100,
      fatalThreshold: 3,
      probeTimeoutMs: 10,
      initial: 'cursor-api',
    });

    for (let index = 0; index < 3; index += 1) {
      await expect(automatic.complete(request)).rejects.toThrow('socket reset');
    }
    expect((await automatic.health()).activeBackend).toBe('cursor-cli');
    expect(warnings).toHaveLength(1);
    expect((await automatic.complete(request)).content).toBe('cursor-cli');
    expect(probe).not.toHaveBeenCalled();

    now = 1_101;
    expect((await automatic.complete(request)).content).toBe('api');
    expect(probe).toHaveBeenCalledOnce();
    expect((await automatic.health()).activeBackend).toBe('cursor-api');
  });

  it('flips immediately for a plain unauthenticated Connect error and redacts diagnostics', async () => {
    const rawMessage = 'upstream rejected sk-auto-AUTH-SECRET';
    const failure = new ConnectRpcError(rawMessage, 'unauthenticated');
    const warnings: string[] = [];
    const cliComplete = vi.fn(async () => ({ content: 'cli', model: request.model }));
    const automatic = new AutoCursorBackend(
      api({ complete: async () => Promise.reject(failure) }),
      backend('cursor-cli', cliComplete),
      {
        now: () => 1_000,
        warn: (message) => warnings.push(message),
        cooldownMs: 100,
        fatalThreshold: 3,
        probeTimeoutMs: 10,
        initial: 'cursor-api',
      },
    );

    await expect(automatic.complete(request)).rejects.toBe(failure);
    const health = await automatic.health();
    expect({
      activeBackend: health.activeBackend,
      consecutiveFatal: health.flipState?.consecutiveFatal,
    }).toEqual({ activeBackend: 'cursor-cli', consecutiveFatal: 3 });
    expect(health.flipState?.reason).toBe('auth: Cursor upstream provider error');
    expect(warnings).toHaveLength(1);
    expect(errorText(failure)).toBe('Cursor upstream provider error');
    const diagnostics = [errorText(failure), health.flipState?.reason ?? '', ...warnings].join(
      '\n',
    );
    expect(diagnostics).not.toContain(rawMessage);
    expect(diagnostics).not.toContain('sk-auto-AUTH-SECRET');

    await expect(automatic.complete(request)).resolves.toMatchObject({ content: 'cli' });
    expect(cliComplete).toHaveBeenCalledOnce();
  });

  it('does not flip or leak provider errors that mention transport text', async () => {
    const warnings: string[] = [];
    const failure = new ConnectRpcError(
      'socket failed sk-auto-SECRET',
      'unauthenticated',
      providerDetails('503'),
      true,
    );
    const automatic = new AutoCursorBackend(
      api({ complete: async () => Promise.reject(failure) }),
      backend('cursor-cli'),
      {
        now: () => 1_000,
        warn: (message) => warnings.push(message),
        cooldownMs: 100,
        fatalThreshold: 3,
        probeTimeoutMs: 10,
        initial: 'cursor-api',
      },
    );

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(automatic.complete(request)).rejects.toBe(failure);
    }

    await expect(automatic.health()).resolves.toMatchObject({
      activeBackend: 'cursor-api',
      flipState: { consecutiveFatal: 0 },
    });
    expect(warnings).toEqual([]);
    expect(JSON.stringify(warnings)).not.toContain('sk-auto-SECRET');
  });

  it('does not flip for a typed provider HTTP 403', async () => {
    const warnings: string[] = [];
    const failure = new CursorApiHttpError(
      403,
      'provider denied',
      'ERROR_PROVIDER_ERROR',
      'run-123',
    );
    const automatic = new AutoCursorBackend(
      api({ complete: async () => Promise.reject(failure) }),
      backend('cursor-cli'),
      {
        now: () => 1_000,
        warn: (message) => warnings.push(message),
        cooldownMs: 100,
        fatalThreshold: 3,
        probeTimeoutMs: 10,
        initial: 'cursor-api',
      },
    );

    await expect(automatic.complete(request)).rejects.toBe(failure);
    await expect(automatic.health()).resolves.toMatchObject({
      activeBackend: 'cursor-api',
      flipState: { consecutiveFatal: 0 },
    });
    expect(warnings).toEqual([]);
  });

  it('does not flip or leak permanent Connect errors with transport-like messages', async () => {
    const warnings: string[] = [];
    const failure = new ConnectRpcError(
      'socket failed sk-auto-PERMANENT',
      'unauthenticated',
      [
        {
          type: 'aiserver.v1.ErrorDetails',
          value: Buffer.from([0x08, 0x0a]).toString('base64').replace(/=+$/u, ''),
        },
      ],
      true,
    );
    const automatic = new AutoCursorBackend(
      api({ complete: async () => Promise.reject(failure) }),
      backend('cursor-cli'),
      {
        now: () => 1_000,
        warn: (message) => warnings.push(message),
        cooldownMs: 100,
        fatalThreshold: 3,
        probeTimeoutMs: 10,
        initial: 'cursor-api',
      },
    );

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(automatic.complete(request)).rejects.toBe(failure);
    }

    await expect(automatic.health()).resolves.toMatchObject({
      activeBackend: 'cursor-api',
      flipState: { consecutiveFatal: 0 },
    });
    expect(warnings).toEqual([]);
    expect(errorText(failure)).toBe('Cursor upstream provider error');
  });

  it.each([
    ['Connect unavailable', new ConnectRpcError('upstream unavailable', 'unavailable')],
    [
      'HTTP/2 GOAWAY',
      Object.assign(new Error('GOAWAY received'), { code: 'ERR_HTTP2_GOAWAY_SESSION' }),
    ],
  ])('flips after repeated canonical %s failures', async (_name, failure) => {
    const direct = api({
      complete: async () => Promise.reject(failure),
    });
    const automatic = new AutoCursorBackend(direct, backend('cursor-cli'), {
      now: () => 1_000,
      warn: vi.fn(),
      cooldownMs: 100,
      fatalThreshold: 3,
      probeTimeoutMs: 10,
      initial: 'cursor-api',
    });

    for (let index = 0; index < 3; index += 1) {
      await expect(automatic.complete(request)).rejects.toBe(failure);
    }

    expect((await automatic.health()).activeBackend).toBe('cursor-cli');
  });

  it('applies a fatal completion flip to the next request without replaying on CLI', async () => {
    const failure = new Error('client is out of date');
    const cliComplete = vi.fn(async () => ({ content: 'cli', model: request.model }));
    const automatic = new AutoCursorBackend(
      api({ complete: async () => Promise.reject(failure) }),
      backend('cursor-cli', cliComplete),
      {
        now: () => 1_000,
        warn: vi.fn(),
        cooldownMs: 100,
        fatalThreshold: 3,
        probeTimeoutMs: 10,
        initial: 'cursor-api',
      },
    );

    await expect(automatic.complete(request)).rejects.toBe(failure);
    expect(cliComplete).not.toHaveBeenCalled();
    await expect(automatic.complete(request)).resolves.toMatchObject({ content: 'cli' });
    expect(cliComplete).toHaveBeenCalledOnce();
  });

  it('applies a fatal streaming flip to the next request without replaying on CLI', async () => {
    const failure = new Error('client is out of date');
    const direct = api();
    direct.completeStream = () => {
      const iterator: AsyncIterableIterator<CompletionStreamEvent> = {
        next: async () => Promise.reject(failure),
        [Symbol.asyncIterator]: () => iterator,
      };
      return iterator;
    };
    const cliStream = vi.fn();
    const fallback = backend('cursor-cli');
    fallback.completeStream = async function* (): AsyncIterable<CompletionStreamEvent> {
      cliStream();
      yield {
        type: 'done',
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        is_error: false,
      };
    };
    const automatic = new AutoCursorBackend(direct, fallback, {
      now: () => 1_000,
      warn: vi.fn(),
      cooldownMs: 100,
      fatalThreshold: 3,
      probeTimeoutMs: 10,
      initial: 'cursor-api',
    });

    const failed = automatic.completeStream(request)[Symbol.asyncIterator]();
    await expect(failed.next()).rejects.toBe(failure);
    expect(cliStream).not.toHaveBeenCalled();
    const nextRequest = automatic.completeStream(request)[Symbol.asyncIterator]();
    await expect(nextRequest.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'done', is_error: false },
    });
    expect(cliStream).toHaveBeenCalledOnce();
  });

  it.each([
    ['HTTP 401', new CursorApiHttpError(401, 'unauthorized')],
    ['outdated client', new Error('client is out of date')],
  ])('flips immediately on %s errors', async (_name, failure) => {
    const direct = api({
      complete: async () => Promise.reject(failure),
    });
    const automatic = new AutoCursorBackend(direct, backend('cursor-cli'), {
      now: () => 1_000,
      warn: vi.fn(),
      cooldownMs: 100,
      fatalThreshold: 3,
      probeTimeoutMs: 10,
      initial: 'cursor-api',
    });

    await expect(automatic.complete(request)).rejects.toBe(failure);
    expect((await automatic.health()).activeBackend).toBe('cursor-cli');
    expect((await automatic.complete(request)).content).toBe('cursor-cli');
  });

  it.each([
    ['HTTP 429', new CursorApiHttpError(429, 'quota')],
    ['ordinary HTTP 400', new CursorApiHttpError(400, 'bad model')],
  ])('does not flip on %s errors', async (_name, failure) => {
    const direct = api({
      complete: async () => Promise.reject(failure),
    });
    const automatic = new AutoCursorBackend(direct, backend('cursor-cli'), {
      now: () => 1_000,
      warn: vi.fn(),
      cooldownMs: 100,
      fatalThreshold: 3,
      probeTimeoutMs: 10,
      initial: 'cursor-api',
    });
    for (let index = 0; index < 4; index += 1) {
      await expect(automatic.complete(request)).rejects.toBe(failure);
    }
    const health = await automatic.health();
    expect(health.activeBackend).toBe('cursor-api');
    expect(health.flipState?.consecutiveFatal).toBe(0);
  });

  it('reads credential usage from cursor-api while CLI fallback is active', async () => {
    const direct = api();
    direct.credentialUsage = vi.fn(async () => [
      {
        id: 'primary',
        enabled: true,
        status: 'fresh' as const,
        fetchedAt: 123,
        pools: {
          cursorModels: { usedPercent: 5, modelIds: ['composer-2.5'] },
          otherModels: { usedPercent: 25 },
        },
      },
    ]);
    const automatic = new AutoCursorBackend(direct, backend('cursor-cli'), {
      now: () => 1_000,
      warn: vi.fn(),
      cooldownMs: 100,
      fatalThreshold: 3,
      probeTimeoutMs: 10,
      initial: 'cursor-cli',
    });

    await expect(automatic.credentialUsage({ force: true })).resolves.toMatchObject([
      { id: 'primary', status: 'fresh' },
    ]);
    expect(direct.credentialUsage).toHaveBeenCalledWith({ force: true });
  });
});
