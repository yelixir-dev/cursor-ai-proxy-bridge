import { describe, expect, it, vi } from 'vitest';
import {
  compareBenchmarkAccounts,
  unprovedAccountComparability,
} from '../src/benchmark/account-comparability.js';
import { AccountComparabilitySchema } from '../src/benchmark/account-schema.js';

const jwt = (subject: string) =>
  `e30.${Buffer.from(JSON.stringify({ sub: subject })).toString('base64url')}.signature`;

const claimAvailability = (
  nativeClaimAvailable: boolean,
  bridgeClaimAvailable: boolean,
  bridgeExchangeAvailable: boolean,
) => ({
  native_claim_available: nativeClaimAvailable,
  bridge_claim_available: bridgeClaimAvailable,
  bridge_exchange_available: bridgeExchangeAvailable,
});

describe('measured account comparability', () => {
  it('records matched and mismatched stable claims without retaining identity values', async () => {
    const native = jwt('native-private-subject');
    const matched = await compareBenchmarkAccounts(native, { CURSOR_AUTH_TOKEN: native });
    const mismatched = await compareBenchmarkAccounts(native, {
      CURSOR_AUTH_TOKEN: jwt('bridge-private-subject'),
    });
    expect(matched).toMatchObject({
      status: 'matched',
      method: 'jwt_sub',
      reason: 'stable_claim_equal',
      identity_status: 'unverified_claim_match',
      cryptographic_identity_proven: false,
      ...claimAvailability(true, true, false),
      account_mismatch: false,
      latency_confounded: true,
    });
    expect(mismatched).toMatchObject({
      status: 'mismatched',
      method: 'jwt_sub',
      reason: 'stable_claim_different',
      identity_status: 'unverified_claim_mismatch',
      cryptographic_identity_proven: false,
      ...claimAvailability(true, true, false),
      account_mismatch: true,
      latency_confounded: true,
    });
    expect(JSON.stringify([matched, mismatched])).not.toMatch(/private-subject|e30\./);
  });

  it('uses the production API-key exchange path without paid completion traffic', async () => {
    const getToken = vi.fn(async () => jwt('same'));
    const receipt = await compareBenchmarkAccounts(
      jwt('same'),
      { CURSOR_API_KEY: 'private-key' },
      undefined,
      {
        authProvider: () => ({ getToken }),
      },
    );
    expect(receipt).toMatchObject({
      status: 'matched',
      method: 'jwt_sub',
      reason: 'stable_claim_equal',
      identity_status: 'unverified_claim_match',
      cryptographic_identity_proven: false,
      ...claimAvailability(true, true, true),
      account_mismatch: false,
      latency_confounded: true,
    });
    expect(getToken).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(receipt)).not.toContain('private-key');
  });

  it.each([
    {
      name: 'missing bridge credential',
      native: jwt('native'),
      environment: {},
      reason: 'bridge_credential_missing',
      nativeClaimAvailable: true,
    },
    {
      name: 'opaque native token',
      native: 'opaque',
      environment: { CURSOR_AUTH_TOKEN: jwt('bridge') },
      reason: 'native_credential_opaque',
      nativeClaimAvailable: false,
    },
    {
      name: 'malformed native token',
      native: 'x.invalid.x',
      environment: { CURSOR_AUTH_TOKEN: jwt('bridge') },
      reason: 'native_credential_malformed',
      nativeClaimAvailable: false,
    },
    {
      name: 'opaque bridge token',
      native: jwt('native'),
      environment: { CURSOR_AUTH_TOKEN: 'opaque' },
      reason: 'bridge_credential_opaque',
      nativeClaimAvailable: true,
    },
    {
      name: 'malformed bridge token',
      native: jwt('native'),
      environment: { CURSOR_AUTH_TOKEN: 'x.invalid.x' },
      reason: 'bridge_credential_malformed',
      nativeClaimAvailable: true,
    },
  ] as const)(
    'records $name as unproved',
    async ({ native, environment, reason, nativeClaimAvailable }) => {
      const receipt = await compareBenchmarkAccounts(native, environment);
      expect(receipt).toMatchObject({
        status: 'unproved',
        method: nativeClaimAvailable ? 'jwt_sub' : 'none',
        reason,
        identity_status: 'unproved',
        cryptographic_identity_proven: false,
        ...claimAvailability(nativeClaimAvailable, false, false),
        account_mismatch: true,
        latency_confounded: true,
      });
      expect(() => AccountComparabilitySchema.parse(receipt)).not.toThrow();
    },
  );

  it('records multiple configured bridge credentials as ambiguous', async () => {
    const receipt = await compareBenchmarkAccounts(jwt('native'), {}, undefined, {
      bridgeCredentials: () => [
        { id: 'one', apiKey: 'private-one', weight: 1, enabled: true },
        { id: 'two', apiKey: 'private-two', weight: 1, enabled: true },
      ],
    });
    expect(receipt).toMatchObject({
      status: 'unproved',
      method: 'jwt_sub',
      reason: 'bridge_credential_ambiguous',
      identity_status: 'unproved',
      cryptographic_identity_proven: false,
      ...claimAvailability(true, false, true),
      account_mismatch: true,
      latency_confounded: true,
    });
    expect(JSON.stringify(receipt)).not.toMatch(/private-one|private-two/);
  });

  it('records exchange failure without leaking the thrown credential detail', async () => {
    const receipt = await compareBenchmarkAccounts(
      jwt('native'),
      { CURSOR_API_KEY: 'secret-key' },
      undefined,
      {
        authProvider: () => ({
          getToken: async () => Promise.reject(new Error('secret-key failed')),
        }),
      },
    );
    expect(receipt).toMatchObject({
      status: 'unproved',
      method: 'jwt_sub',
      reason: 'bridge_exchange_failed',
      identity_status: 'unproved',
      cryptographic_identity_proven: false,
      ...claimAvailability(true, false, true),
      account_mismatch: true,
      latency_confounded: true,
    });
    expect(JSON.stringify(receipt)).not.toContain('secret-key');
  });

  it('uses an explicit conservative dry-run receipt', () => {
    expect(unprovedAccountComparability('dry_run')).toMatchObject({
      status: 'unproved',
      method: 'none',
      reason: 'dry_run',
      identity_status: 'unproved',
      cryptographic_identity_proven: false,
      ...claimAvailability(false, false, false),
      account_mismatch: true,
      latency_confounded: true,
    });
  });
});
