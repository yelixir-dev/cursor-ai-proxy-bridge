import { z } from 'zod';
import type { AccountComparability } from './account-comparability.js';

export const AccountComparabilitySchema = z.strictObject({
  status: z.enum(['matched', 'mismatched', 'unproved']),
  method: z.enum(['jwt_sub', 'none']),
  reason: z.enum([
    'stable_claim_equal',
    'stable_claim_different',
    'native_credential_opaque',
    'native_credential_malformed',
    'bridge_credential_missing',
    'bridge_credential_ambiguous',
    'bridge_credential_opaque',
    'bridge_credential_malformed',
    'bridge_exchange_failed',
    'dry_run',
  ]),
  identity_status: z.enum(['unverified_claim_match', 'unverified_claim_mismatch', 'unproved']),
  cryptographic_identity_proven: z.literal(false),
  native_claim_available: z.boolean(),
  bridge_claim_available: z.boolean(),
  bridge_exchange_available: z.boolean(),
  account_mismatch: z.boolean(),
  latency_confounded: z.boolean(),
});

export function validateAccountComparability(
  companions: {
    account_mismatch: boolean;
    latency_confounded: boolean;
    account_comparability: AccountComparability;
  },
  context: z.RefinementCtx,
): void {
  const comparison = companions.account_comparability;
  const matched = comparison.status === 'matched';
  const coherent =
    companions.account_mismatch === comparison.account_mismatch &&
    companions.latency_confounded === comparison.latency_confounded &&
    comparison.account_mismatch === !matched &&
    comparison.latency_confounded &&
    !comparison.cryptographic_identity_proven &&
    (matched
      ? comparison.reason === 'stable_claim_equal' &&
        comparison.identity_status === 'unverified_claim_match' &&
        comparison.method === 'jwt_sub' &&
        comparison.native_claim_available &&
        comparison.bridge_claim_available
      : comparison.status === 'mismatched'
        ? comparison.reason === 'stable_claim_different' &&
          comparison.identity_status === 'unverified_claim_mismatch' &&
          comparison.method === 'jwt_sub' &&
          comparison.native_claim_available &&
          comparison.bridge_claim_available
        : comparison.identity_status === 'unproved' &&
          comparison.reason !== 'stable_claim_equal' &&
          comparison.reason !== 'stable_claim_different');
  if (!coherent) {
    context.addIssue({
      code: 'custom',
      path: ['companions', 'account_comparability'],
      message: 'account comparability receipt is internally inconsistent',
    });
  }
}
