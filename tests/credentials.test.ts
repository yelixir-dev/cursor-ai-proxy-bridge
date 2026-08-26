// allow: SIZE_OK — cohesive credential routing matrix shares failure fixtures and router state.
import { describe, expect, it } from 'vitest';
import { ConnectRpcError } from '../src/backend/cursor-api/connect-frame.js';
import {
  CursorCredentialRouter,
  cursorCredentialsFromConfig,
  NoAvailableCursorCredentialError,
} from '../src/backend/cursor-api/credentials.js';
import { createCursorApiRuntime } from '../src/backend/cursor-api/runtime.js';
import { CursorApiHttpError } from '../src/backend/cursor-api/transport.js';
import type { BridgeConfig } from '../src/config.js';
import { canonicalProviderDetailValue, providerError } from './support/provider-error-fixtures.js';

const runtimeConfig: BridgeConfig = {
  host: '127.0.0.1',
  port: 9997,
  clientAuth: 'off',
  backend: 'cursor-api',
  defaultModel: 'composer-2.5',
  workspaceMode: 'chat-only',
  version: 'test',
  cursorApiCredentials: [
    { id: 'primary', apiKey: 'key-primary', weight: 99, enabled: true },
    { id: 'secondary', apiKey: 'key-secondary', weight: 1, enabled: true },
  ],
};

describe('Cursor API credential routing', () => {
  it('uses smooth weighted round-robin with a 1:2 distribution', () => {
    const router = new CursorCredentialRouter({
      credentials: [
        { id: 'one', apiKey: 'key-one', weight: 1 },
        { id: 'two', apiKey: 'key-two', weight: 2 },
      ],
    });
    const picks = Array.from({ length: 6 }, () => {
      const credential = router.pick();
      router.release(credential.id);
      return credential.id;
    });

    expect(picks.filter((id) => id === 'one')).toHaveLength(2);
    expect(picks.filter((id) => id === 'two')).toHaveLength(4);
  });

  it('preserves a 99:1 distribution in the default weighted mode', () => {
    const router = new CursorCredentialRouter({
      credentials: runtimeConfig.cursorApiCredentials ?? [],
    });
    const picks = Array.from({ length: 100 }, () => {
      const credential = router.pick();
      router.release(credential.id);
      return credential.id;
    });

    expect(picks.filter((id) => id === 'primary')).toHaveLength(99);
    expect(picks.filter((id) => id === 'secondary')).toHaveLength(1);
  });

  it('spreads a 99:1 pool evenly when round-robin routing is configured', () => {
    const runtime = createCursorApiRuntime(runtimeConfig, {
      environment: { CURSOR_BRIDGE_CREDENTIAL_ROUTING: 'round_robin' },
    });
    const picks = Array.from({ length: 4 }, () => {
      const credential = runtime.credentialRouter.pick();
      runtime.credentialRouter.release(credential.id);
      return credential.id;
    });

    expect(picks).toEqual(['primary', 'secondary', 'primary', 'secondary']);
  });

  it('routes every Fable alias only to an explicitly capable credential', async () => {
    const router = new CursorCredentialRouter({
      credentials: [
        { id: 'pro-plus', apiKey: 'key-pro-plus', plan: 'pro_plus', weight: 99 },
        {
          id: 'ultra',
          apiKey: 'key-ultra',
          plan: 'ultra',
          capabilities: { fable: true },
          weight: 1,
        },
      ],
      routingPolicy: 'ultra_last',
    });

    for (const model of ['fable-5', 'claude-fable-5', 'fable-5-thinking']) {
      await expect(router.route(async (credential) => credential.id, { model })).resolves.toBe(
        'ultra',
      );
    }
  });

  it('rejects Fable before upstream when no Ultra credential is available', async () => {
    const router = new CursorCredentialRouter({
      credentials: [{ id: 'pro-plus', apiKey: 'key-pro-plus', plan: 'pro_plus' }],
      routingPolicy: 'ultra_last',
    });
    const attempted: string[] = [];

    await expect(
      router.route(
        async (credential) => {
          attempted.push(credential.id);
          return credential.id;
        },
        { model: 'fable-5' },
      ),
    ).rejects.toThrow(
      'Model fable-5 requires an Ultra credential; no eligible Ultra credential is currently available',
    );
    expect(attempted).toEqual([]);
  });

  it('reserves Ultra for normal models until non-Ultra credentials are unavailable', () => {
    const router = new CursorCredentialRouter({
      credentials: [
        { id: 'ultra', apiKey: 'key-ultra', plan: 'ultra', capabilities: { fable: true } },
        { id: 'pro-plus', apiKey: 'key-pro-plus', plan: 'pro_plus' },
        { id: 'pro', apiKey: 'key-pro', plan: 'pro' },
      ],
      routingPolicy: 'ultra_last',
      now: () => 1_000,
    });

    const initial = [router.pick([], 'composer-2.5'), router.pick([], 'composer-2.5')];
    for (const credential of initial) router.release(credential.id);
    expect(initial.map((credential) => credential.id).sort()).toEqual(['pro', 'pro-plus']);

    router.disable('pro-plus', 'billing');
    router.disable('pro', 'cooldown');
    const reserved = router.pick([], 'composer-2.5');
    router.release(reserved.id);
    expect(reserved.id).toBe('ultra');
  });

  it('fails over from exhausted non-Ultra capacity to the Ultra reserve', async () => {
    const router = new CursorCredentialRouter({
      credentials: [
        { id: 'pro-plus', apiKey: 'key-pro-plus', plan: 'pro_plus' },
        { id: 'ultra', apiKey: 'key-ultra', plan: 'ultra', capabilities: { fable: true } },
      ],
      routingPolicy: 'ultra_last',
      failoverOn: 'auth_or_quota_or_5xx',
    });
    const attempted: string[] = [];

    await expect(
      router.route(
        async (credential) => {
          attempted.push(credential.id);
          if (credential.id === 'pro-plus') {
            throw new CursorApiHttpError(503, 'unavailable');
          }
          return credential.id;
        },
        { model: 'composer-2.5' },
      ),
    ).resolves.toBe('ultra');
    expect(attempted).toEqual(['pro-plus', 'ultra']);
  });

  it('reports safe model-aware selection metadata for each routed credential', async () => {
    const router = new CursorCredentialRouter({
      credentials: [
        { id: 'pro-plus', apiKey: 'key-pro-plus', plan: 'pro_plus' },
        { id: 'ultra', apiKey: 'key-ultra', plan: 'ultra', capabilities: { fable: true } },
      ],
      routingPolicy: 'ultra_last',
      failoverOn: 'auth_or_quota_or_5xx',
    });
    const decisions: Array<{
      selectedCredentialId: string;
      selectedPlan: string;
      eligibility: string;
      ultraReserveBypassed: boolean;
    }> = [];

    await router.route(
      async (credential) => {
        if (credential.id === 'pro-plus') throw new CursorApiHttpError(503, 'unavailable');
        return credential.id;
      },
      {
        model: 'composer-2.5',
        onSelection: (decision) => decisions.push(decision),
      },
    );

    expect(decisions).toEqual([
      {
        selectedCredentialId: 'pro-plus',
        selectedPlan: 'pro_plus',
        eligibility: 'standard',
        routingPolicy: 'ultra_last',
        ultraReserveBypassed: false,
      },
      {
        selectedCredentialId: 'ultra',
        selectedPlan: 'ultra',
        eligibility: 'standard',
        routingPolicy: 'ultra_last',
        ultraReserveBypassed: true,
      },
    ]);
  });

  it('hot-updates routing and failover policy for subsequent requests', async () => {
    const router = new CursorCredentialRouter({
      credentials: runtimeConfig.cursorApiCredentials ?? [],
    });
    const weighted = router.pick();
    router.release(weighted.id);
    expect(weighted.id).toBe('primary');

    router.updatePolicy({
      routingPolicy: 'round_robin',
      failoverOn: 'auth_or_quota_or_5xx',
    });

    expect(router.policy()).toEqual({
      routingPolicy: 'round_robin',
      failoverOn: 'auth_or_quota_or_5xx',
    });
    const evenPicks = Array.from({ length: 4 }, () => {
      const credential = router.pick();
      router.release(credential.id);
      return credential.id;
    });
    expect(evenPicks).toEqual(['primary', 'secondary', 'primary', 'secondary']);

    const attempts: string[] = [];
    await expect(
      router.route(async (credential) => {
        attempts.push(credential.id);
        if (credential.id === 'primary') throw new CursorApiHttpError(503, 'unavailable');
        return credential.id;
      }),
    ).resolves.toBe('secondary');
    expect(attempts).toEqual(['primary', 'secondary']);
  });

  it('prefers persisted dashboard policy over environment policy after restart', async () => {
    const runtime = createCursorApiRuntime(
      {
        ...runtimeConfig,
        dashboardConfig: {
          credentialPolicy: {
            routingPolicy: 'round_robin',
            failoverOn: 'auth_or_quota_or_5xx',
          },
        },
      },
      {
        environment: {
          CURSOR_BRIDGE_CREDENTIAL_ROUTING: 'weighted_round_robin',
          CURSOR_BRIDGE_FAILOVER_ON: 'auth',
        },
      },
    );
    const picks = Array.from({ length: 4 }, () => {
      const credential = runtime.credentialRouter.pick();
      runtime.credentialRouter.release(credential.id);
      return credential.id;
    });
    expect(picks).toEqual(['primary', 'secondary', 'primary', 'secondary']);

    const attempts: string[] = [];
    await expect(
      runtime.credentialRouter.route(async (credential) => {
        attempts.push(credential.id);
        if (credential.id === 'primary') throw new CursorApiHttpError(503, 'unavailable');
        return credential.id;
      }),
    ).resolves.toBe('secondary');
    expect(attempts).toEqual(['primary', 'secondary']);
  });

  it.each([
    ['CURSOR_BRIDGE_CREDENTIAL_ROUTING', 'random'],
    ['CURSOR_BRIDGE_FAILOVER_ON', 'everything'],
  ])('rejects invalid credential routing config %s=%s', (name, value) => {
    expect(() =>
      createCursorApiRuntime(runtimeConfig, {
        environment: { [name]: value },
      }),
    ).toThrow(new RegExp(`${name} must be one of`));
  });

  it('disables an auth-failed credential and retries once with the next pick', async () => {
    const router = new CursorCredentialRouter({
      credentials: [
        { id: 'first', apiKey: 'key-first' },
        { id: 'second', apiKey: 'key-second' },
      ],
      now: () => 1_000,
      cooldownMs: 500,
    });
    const attempted: string[] = [];

    const result = await router.route(async (credential) => {
      attempted.push(credential.id);
      if (credential.id === 'first') throw new CursorApiHttpError(401, 'unauthenticated');
      return credential.id;
    });

    expect(result).toBe('second');
    expect(attempted).toEqual(['first', 'second']);
    expect(router.snapshot()).toEqual([
      expect.objectContaining({
        id: 'first',
        disabledReason: 'auth',
        disabledUntil: 1_500,
        inFlight: 0,
      }),
      expect.objectContaining({ id: 'second', inFlight: 0 }),
    ]);
  });

  it.each([
    ['HTTP 402', new CursorApiHttpError(402, 'billing exhausted')],
    [
      'value-class usage limit',
      new ConnectRpcError(
        'usage exhausted',
        'resource_exhausted',
        [
          {
            type: 'aiserver.v1.ErrorDetails',
            debug: {
              error: 'ERROR_FREE_USER_USAGE_LIMIT',
              details: { isRetryable: false },
            },
          },
        ],
        true,
      ),
    ],
  ])('fails over %s as billing under auth_or_quota', async (_caseName, failure) => {
    const router = new CursorCredentialRouter({
      credentials: [
        { id: 'primary', apiKey: 'key-primary' },
        { id: 'secondary', apiKey: 'key-secondary' },
      ],
      failoverOn: 'auth_or_quota',
      now: () => 1_000,
      cooldownMs: 500,
    });
    const attempted: string[] = [];

    const result = await router.route(async (credential) => {
      attempted.push(credential.id);
      if (credential.id === 'primary') throw failure;
      return credential.id;
    });

    expect(result).toBe('secondary');
    expect(attempted).toEqual(['primary', 'secondary']);
    expect(router.snapshot()[0]).toMatchObject({
      id: 'primary',
      disabledReason: 'billing',
      disabledUntil: 1_500,
      inFlight: 0,
    });
  });

  it.each([
    ['HTTP 429', new CursorApiHttpError(429, 'rate limited')],
    ['HTTP 503', new CursorApiHttpError(503, 'unavailable')],
    ['provider resource_exhausted', providerError('503')],
  ])('fails over %s as cooldown under auth_or_quota_or_5xx', async (_caseName, failure) => {
    const router = new CursorCredentialRouter({
      credentials: [
        { id: 'primary', apiKey: 'key-primary' },
        { id: 'secondary', apiKey: 'key-secondary' },
      ],
      failoverOn: 'auth_or_quota_or_5xx',
      now: () => 1_000,
      cooldownMs: 500,
    });
    const attempted: string[] = [];

    const result = await router.route(async (credential) => {
      attempted.push(credential.id);
      if (credential.id === 'primary') throw failure;
      return credential.id;
    });

    expect(result).toBe('secondary');
    expect(attempted).toEqual(['primary', 'secondary']);
    expect(router.snapshot()[0]).toMatchObject({
      id: 'primary',
      disabledReason: 'cooldown',
      disabledUntil: 1_500,
      inFlight: 0,
    });
  });

  it('keeps transient failures on the selected credential under the auth default', async () => {
    const router = new CursorCredentialRouter({
      credentials: [
        { id: 'primary', apiKey: 'key-primary' },
        { id: 'secondary', apiKey: 'key-secondary' },
      ],
    });
    const failure = new CursorApiHttpError(503, 'unavailable');
    const attempted: string[] = [];

    await expect(
      router.route(async (credential) => {
        attempted.push(credential.id);
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(attempted).toEqual(['primary']);
    expect(router.snapshot().some((state) => state.disabledReason !== undefined)).toBe(false);
  });

  it.each([7, 8, 22, 50, 51])(
    'classifies permanent rate-limit enum %i as cooldown rather than billing',
    async (errorNumber) => {
      const router = new CursorCredentialRouter({
        credentials: [
          { id: 'primary', apiKey: 'key-primary' },
          { id: 'secondary', apiKey: 'key-secondary' },
        ],
        failoverOn: 'auth_or_quota_or_5xx',
        now: () => 1_000,
        cooldownMs: 500,
      });
      const failure = new ConnectRpcError(
        'rate limited',
        'resource_exhausted',
        [
          {
            type: 'aiserver.v1.ErrorDetails',
            value: canonicalProviderDetailValue('400', errorNumber),
          },
        ],
        true,
      );

      await expect(
        router.route(async (credential) => {
          if (credential.id === 'primary') throw failure;
          return credential.id;
        }),
      ).resolves.toBe('secondary');
      expect(router.snapshot()[0]).toMatchObject({
        disabledReason: 'cooldown',
        disabledUntil: 1_500,
      });
    },
  );

  it('does not fail over the PRO_USER_ONLY capability error', async () => {
    const router = new CursorCredentialRouter({
      credentials: [
        { id: 'primary', apiKey: 'key-primary' },
        { id: 'secondary', apiKey: 'key-secondary' },
      ],
      failoverOn: 'auth_or_quota_or_5xx',
    });
    const failure = new ConnectRpcError(
      'pro user required',
      'resource_exhausted',
      [
        {
          type: 'aiserver.v1.ErrorDetails',
          value: canonicalProviderDetailValue('400', 23),
        },
      ],
      true,
    );
    const attempted: string[] = [];

    await expect(
      router.route(async (credential) => {
        attempted.push(credential.id);
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(attempted).toEqual(['primary']);
    expect(router.snapshot().some((state) => state.disabledReason !== undefined)).toBe(false);
  });

  it('lazily recovers a credential after its cooldown', () => {
    let now = 1_000;
    const router = new CursorCredentialRouter({
      credentials: [{ id: 'only', apiKey: 'key-only' }],
      now: () => now,
      cooldownMs: 500,
    });
    router.disable('only', 'auth');

    expect(() => router.pick()).toThrow(NoAvailableCursorCredentialError);
    now = 1_500;
    const recovered = router.pick();
    router.release(recovered.id);
    expect(recovered.id).toBe('only');
    expect(router.snapshot()[0]).not.toHaveProperty('disabledReason');
  });

  it('constructs env first, appends dashboard credentials, and falls back to system', () => {
    const credentials = cursorCredentialsFromConfig({ CURSOR_API_KEY: 'env-test-key' }, [
      { id: 'dashboard', label: 'Dashboard', apiKey: 'dashboard-test-key' },
    ]);
    expect(credentials.map(({ id, weight, enabled }) => ({ id, weight, enabled }))).toEqual([
      { id: 'env', weight: 1, enabled: true },
      { id: 'dashboard', weight: 1, enabled: true },
    ]);
    expect(cursorCredentialsFromConfig({})).toEqual([{ id: 'system', weight: 1, enabled: true }]);
  });
});
