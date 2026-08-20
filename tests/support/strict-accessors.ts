/**
 * Fail-fast typed accessors for optional values in test fixtures.
 *
 * Each helper throws with a fixture label when the invariant it guards is
 * violated, so a broken fixture fails loudly instead of asserting away the
 * optionality with a non-null assertion.
 */
export function requireValue<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) {
    throw new Error(`${label} must be present in the fixture`);
  }
  return value;
}
