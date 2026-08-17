import { describe, expect, it, vi } from 'vitest';
import {
  AutoCursorBackend,
  createConfiguredBackend,
  type ProbeableCursorApiBackend,
} from '../src/backend/auto.js';
import { CursorApiHttpError } from '../src/backend/cursor-api/transport.js';
import type {
  BackendHealth,
  ChatCompletionRequest,
  CompletionResult,
  CompletionStreamEvent,
  CursorBackend,
} from '../src/backend/types.js';
import type { BridgeConfig } from '../src/config.js';

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
});
