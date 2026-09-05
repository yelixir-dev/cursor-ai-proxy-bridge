export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function record(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  // Retain the reflection encoder's Object.entries coercion for malformed input;
  // the decoded exec boundary owns rejection, not this wire serializer.
  return Object.fromEntries(Object.entries(value ?? {}));
}

export function array(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  throw new TypeError('protobuf repeated field requires an array');
}

export function jsonToProtoValue(value: unknown): Record<string, unknown> {
  if (value === null) return { kind: { case: 'nullValue', value: 0 } };
  if (typeof value === 'number') return { kind: { case: 'numberValue', value } };
  if (typeof value === 'string') return { kind: { case: 'stringValue', value } };
  if (typeof value === 'boolean') return { kind: { case: 'boolValue', value } };
  if (Array.isArray(value)) {
    return { kind: { case: 'listValue', value: { values: array(value).map(jsonToProtoValue) } } };
  }
  const fields = Object.fromEntries(
    Object.entries(record(value ?? {})).map(([key, item]) => [key, jsonToProtoValue(item)]),
  );
  return { kind: { case: 'structValue', value: { fields } } };
}

export function protoValueToJson(value: Record<string, unknown>): unknown {
  const kind = value.kind;
  if (!isRecord(kind)) return null;
  switch (kind.case) {
    case 'nullValue':
      return null;
    case 'numberValue':
    case 'stringValue':
    case 'boolValue':
      return kind.value;
    case 'listValue': {
      const list = record(kind.value ?? {});
      return array(list.values ?? []).map((item) => protoValueToJson(record(item)));
    }
    case 'structValue': {
      const struct = record(kind.value ?? {});
      return Object.fromEntries(
        Object.entries(record(struct.fields ?? {})).map(([key, item]) => [
          key,
          protoValueToJson(record(item)),
        ]),
      );
    }
    default:
      return null;
  }
}
