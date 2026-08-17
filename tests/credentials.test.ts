import { describe, expect, it } from 'vitest';
import {
  CursorCredentialRouter,
  NoAvailableCursorCredentialError,
  cursorCredentialsFromConfig,
} from '../src/backend/cursor-api/credentials.js';
import { CursorApiHttpError } from '../src/backend/cursor-api/transport.js';

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
