import assert from 'node:assert/strict';

type FieldPath = readonly (string | number)[];

export function objectAt(value: unknown, path: FieldPath = []): Record<string, unknown> {
  const found = valueAt(value, path);
  assert.ok(
    found !== null && typeof found === 'object' && !Array.isArray(found),
    'Expected protobuf object',
  );
  return Object.fromEntries(Object.entries(found));
}

export function arrayAt(value: unknown, path: FieldPath = []): unknown[] {
  const found = valueAt(value, path);
  assert.ok(Array.isArray(found), 'Expected protobuf array');
  return found;
}

export function bufferAt(value: unknown, path: FieldPath = []): Buffer {
  const found = valueAt(value, path);
  assert.ok(Buffer.isBuffer(found), 'Expected protobuf bytes');
  return found;
}

export function valueAt(value: unknown, path: FieldPath): unknown {
  let found = value;
  for (const key of path) {
    found = typeof key === 'number' ? arrayAt(found)[key] : objectAt(found)[key];
  }
  return found;
}
