import { describe, expect, it, vi } from 'vitest';
import {
  CursorCredentialUsageService,
  type CursorUsageTokenProvider,
} from '../src/backend/cursor-api/account-usage.js';
import type { CursorApiCredential } from '../src/backend/cursor-api/credentials.js';

const credential: CursorApiCredential = {
  id: 'primary',
  label: '운영 계정',
  apiKey: 'test-secret',
  weight: 1,
  enabled: true,
};

const usagePayload = {
  billingCycleStart: '1_780_000_000_000'.replaceAll('_', ''),
  billingCycleEnd: '1_782_678_400_000'.replaceAll('_', ''),
  planUsage: {
    totalSpend: 4_000,
    includedSpend: 4_000,
    remaining: 11_000,
    limit: 15_000,
    autoSpend: 1_000,
    autoLimit: 5_000,
    apiSpend: 3_000,
    apiLimit: 10_000,
    autoPercentUsed: 20,
    apiPercentUsed: 30,
    totalPercentUsed: 26.67,
  },
  spendLimitUsage: {
    limitType: 'user',
    individualLimit: 5_000,
    individualUsed: 1_500,
    individualRemaining: 3_500,
  },
  autoBucketModels: ['composer-2.5', 'cursor-grok-4.6'],
};

const planPayload = {
  planInfo: {
    planName: 'Ultra',
    includedAmountCents: 15_000,
    price: '$200/mo',
    billingCycleEnd: usagePayload.billingCycleEnd,
    planOwner: 'PLAN_OWNER_STRIPE',
  },
};

function response(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function service(options: { fetch: typeof globalThis.fetch; now?: () => number; ttlMs?: number }) {
  const auth = {
    getToken: vi.fn(async () => 'access-token'),
  } satisfies CursorUsageTokenProvider;
  return {
    auth,
    usage: new CursorCredentialUsageService({
      auth,
      fetch: options.fetch,
      now: options.now,
      ttlMs: options.ttlMs,
      apiEndpoint: 'https://api2.cursor.sh',
    }),
  };
}

describe('Cursor credential account usage', () => {
  it('maps authoritative pool, plan, cycle, and on-demand values', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(usagePayload))
      .mockResolvedValueOnce(response(planPayload));
    const { auth, usage } = service({ fetch: fetchMock, now: () => 123_456 });

    await expect(usage.snapshots([credential])).resolves.toEqual([
      {
        id: 'primary',
        label: '운영 계정',
        enabled: true,
        status: 'fresh',
        fetchedAt: 123_456,
        plan: {
          name: 'Ultra',
          includedAmountCents: 15_000,
          price: '$200/mo',
          owner: 'stripe',
        },
        cycle: {
          startsAt: 1_780_000_000_000,
          resetsAt: 1_782_678_400_000,
        },
        pools: {
          cursorModels: {
            usedPercent: 20,
            spentCents: 1_000,
            limitCents: 5_000,
            remainingCents: 4_000,
            modelIds: ['composer-2.5', 'cursor-grok-4.6'],
          },
          otherModels: {
            usedPercent: 30,
            spentCents: 3_000,
            limitCents: 10_000,
            remainingCents: 7_000,
          },
        },
        included: {
          usedPercent: 26.67,
          spentCents: 4_000,
          limitCents: 15_000,
          remainingCents: 11_000,
        },
        onDemand: {
          limitType: 'user',
          limitCents: 5_000,
          usedCents: 1_500,
          remainingCents: 3_500,
        },
      },
    ]);
    expect(auth.getToken).toHaveBeenCalledWith(credential, expect.any(AbortSignal));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage',
      'https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo',
    ]);
  });

  it('does not invent exact per-pool remaining values when optional counters are absent', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({
          billingCycleEnd: usagePayload.billingCycleEnd,
          planUsage: {
            totalSpend: 4_000,
            includedSpend: 4_000,
            remaining: 11_000,
            limit: 15_000,
            autoPercentUsed: 4.5,
            apiPercentUsed: 28,
          },
          autoBucketModels: ['composer-2.5'],
        }),
      )
      .mockResolvedValueOnce(response(planPayload));
    const { usage } = service({ fetch: fetchMock });

    const [snapshot] = await usage.snapshots([credential]);

    expect(snapshot?.pools.cursorModels).toEqual({
      usedPercent: 4.5,
      modelIds: ['composer-2.5'],
    });
    expect(snapshot?.pools.otherModels).toEqual({ usedPercent: 28 });
    expect(snapshot?.included).toMatchObject({ remainingCents: 11_000 });
  });

  it('reuses fresh snapshots and supports an explicit refresh', async () => {
    let now = 10_000;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async (url) =>
        response(String(url).endsWith('/GetPlanInfo') ? planPayload : usagePayload),
      );
    const { usage } = service({ fetch: fetchMock, now: () => now, ttlMs: 5_000 });

    await usage.snapshots([credential]);
    now += 1_000;
    await usage.snapshots([credential]);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await usage.snapshots([credential], { force: true });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('returns the last snapshot as stale when refresh fails', async () => {
    let now = 10_000;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(usagePayload))
      .mockResolvedValueOnce(response(planPayload));
    const { usage } = service({ fetch: fetchMock, now: () => now, ttlMs: 5_000 });
    await usage.snapshots([credential]);
    now += 6_000;
    fetchMock.mockRejectedValue(new Error('offline'));

    const [snapshot] = await usage.snapshots([credential]);

    expect(snapshot).toMatchObject({
      id: 'primary',
      status: 'stale',
      fetchedAt: 10_000,
      error: { kind: 'upstream' },
    });
    expect(snapshot?.pools.cursorModels.usedPercent).toBe(20);
  });
});
