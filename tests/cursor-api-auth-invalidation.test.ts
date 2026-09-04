import { describe, expect, it } from 'vitest';
import { CursorAuthProvider } from '../src/backend/cursor-api/auth.js';
import type { CursorApiCredential } from '../src/backend/cursor-api/credentials.js';

const credential: CursorApiCredential = {
  id: 'rotated',
  apiKey: 'old-key',
  enabled: true,
  weight: 1,
};

describe('Cursor authentication invalidation', () => {
  it.each(['credential', 'all'] as const)(
    'rejects an obsolete exchange after %s invalidation without poisoning its replacement',
    async (scope) => {
      // Given: the old identity has an exchange in flight.
      const oldResponse = Promise.withResolvers<Response>();
      const newResponse = Promise.withResolvers<Response>();
      const keys: string[] = [];
      const auth = new CursorAuthProvider({
        environment: {},
        fetch: async (_url, options) => {
          const key = new Headers(options?.headers).get('authorization') ?? '';
          keys.push(key);
          return key === 'Bearer old-key' ? oldResponse.promise : newResponse.promise;
        },
      });
      const oldResult = auth.getToken(credential).then(
        (token) => ({ token }),
        (error: unknown) => ({ error }),
      );

      // When: rotation invalidates the old exchange before either response arrives.
      auth.invalidate(scope === 'all' ? undefined : credential.id);
      const replacement = { ...credential, apiKey: 'new-key' };
      const newToken = auth.getToken(replacement);
      oldResponse.resolve(Response.json({ accessToken: 'obsolete-token' }));
      newResponse.resolve(Response.json({ accessToken: 'replacement-token' }));

      // Then: old waiters fail, new waiters and the cache only see the new identity.
      expect(await oldResult).toEqual({
        error: expect.objectContaining({ name: 'CursorAuthInvalidatedError' }),
      });
      await expect(newToken).resolves.toBe('replacement-token');
      await expect(auth.getToken(replacement)).resolves.toBe('replacement-token');
      expect(keys).toEqual(['Bearer old-key', 'Bearer new-key']);
    },
  );

  it('keeps a replacement exchange single-flight when an obsolete exchange finishes', async () => {
    // Given: two generations of one credential, with the new exchange still pending.
    const oldResponse = Promise.withResolvers<Response>();
    const newResponse = Promise.withResolvers<Response>();
    let exchanges = 0;
    const auth = new CursorAuthProvider({
      environment: {},
      fetch: async (_url, options) => {
        exchanges += 1;
        return new Headers(options?.headers).get('authorization') === 'Bearer old-key'
          ? oldResponse.promise
          : newResponse.promise;
      },
    });
    const obsolete = auth.getToken(credential).catch((error: unknown) => error);
    auth.invalidate(credential.id);
    const replacement = { ...credential, apiKey: 'new-key' };
    const firstWaiter = auth.getToken(replacement);

    // When: the obsolete generation settles before another waiter joins the new one.
    oldResponse.resolve(Response.json({ accessToken: 'obsolete-token' }));
    await obsolete;
    const secondWaiter = auth.getToken(replacement);
    newResponse.resolve(Response.json({ accessToken: 'replacement-token' }));

    // Then: both new waiters receive the replacement identity through one exchange.
    await expect(Promise.all([firstWaiter, secondWaiter])).resolves.toEqual([
      'replacement-token',
      'replacement-token',
    ]);
    expect(exchanges).toBe(2);
  });

  it('does not invalidate another credential exchange', async () => {
    // Given: independent identities have exchanges in flight.
    const response = Promise.withResolvers<Response>();
    const auth = new CursorAuthProvider({
      environment: {},
      fetch: async () => response.promise,
    });
    const unaffected = auth.getToken({ ...credential, id: 'unaffected' });

    // When: only a different credential is invalidated.
    auth.invalidate(credential.id);
    response.resolve(Response.json({ accessToken: 'unaffected-token' }));

    // Then: the unaffected request remains usable.
    await expect(unaffected).resolves.toBe('unaffected-token');
  });
});
