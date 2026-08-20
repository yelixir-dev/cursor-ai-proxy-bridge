import type { AccountComparability } from './account-comparability.js';

export function accountComparabilityRows(
  comparison: AccountComparability,
): ReadonlyArray<readonly [string, string]> {
  return [
    ['account_status', comparison.status],
    ['account_method', comparison.method],
    ['account_reason', comparison.reason],
    ['identity_status', comparison.identity_status],
    ['cryptographic_identity_proven', String(comparison.cryptographic_identity_proven)],
    ['native_claim_available', String(comparison.native_claim_available)],
    ['bridge_claim_available', String(comparison.bridge_claim_available)],
    ['bridge_exchange_available', String(comparison.bridge_exchange_available)],
  ];
}
