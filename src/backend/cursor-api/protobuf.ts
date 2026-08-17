import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface ProtoFieldDescriptor {
  no: number;
  name: string;
  localName: string;
  kind: 'scalar' | 'enum' | 'message' | 'map';
  scalar?: number;
  enum?: string;
  message?: string;
  repeated: boolean;
  oneof?: string;
  map?: {
    keyScalar: number;
    valueKind: 'scalar' | 'enum' | 'message';
    valueScalar?: number;
    valueEnum?: string;
    valueMessage?: string;
  };
}

export interface ProtoDescriptorSet {
  format: number;
  bundleVersion: string;
  clientVersion: string;
  roots: string[];
  services: Array<{
    service: string;
    method: string;
    input: string;
    output: string;
    kind: string;
  }>;
  messages: Record<string, { fields: ProtoFieldDescriptor[] }>;
}

const MISSING_DESCRIPTOR_MESSAGE =
  'Cursor API protobuf descriptors are missing. Run `npm run extract-protos` with cursor-agent installed, then rebuild — or set CURSOR_BRIDGE_CURSOR_API_DESCRIPTORS to an extracted proto-descriptors.json (for headless-only hosts without cursor-agent).';

export function loadProtoDescriptors(path?: string): ProtoDescriptorSet {
  const descriptorPath =
    path ?? fileURLToPath(new URL('./proto-descriptors.json', import.meta.url));
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(descriptorPath, 'utf8'));
  } catch (error) {
    const detail = error instanceof Error ? ` (${error.message})` : '';
    throw new Error(`${MISSING_DESCRIPTOR_MESSAGE}${detail}`, { cause: error });
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    (parsed as { format?: unknown }).format !== 1 ||
    !(parsed as { messages?: unknown }).messages
  ) {
    throw new Error(
      `Cursor API protobuf descriptor file is invalid. Run \`npm run extract-protos\` again: ${descriptorPath}`,
    );
  }
  return parsed as ProtoDescriptorSet;
}

function varint(value: number | bigint): Buffer {
  let current = typeof value === 'bigint' ? value : BigInt(Math.trunc(value));
  if (current < 0) current = BigInt.asUintN(64, current);
  const bytes: number[] = [];
  do {
    let byte = Number(current & 0x7fn);
    current >>= 7n;
    if (current) byte |= 0x80;
    bytes.push(byte);
  } while (current);
  return Buffer.from(bytes);
}

function readVarint(buffer: Buffer, start: number): { value: bigint; offset: number } {
  let value = 0n;
  let shift = 0n;
  let offset = start;
  while (offset < buffer.length && shift <= 70n) {
    const byte = buffer[offset++]!;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, offset };
    shift += 7n;
  }
  throw new Error('invalid protobuf varint');
}

function scalarWireType(scalar: number): number {
  if (scalar === 1 || scalar === 6 || scalar === 16) return 1;
  if (scalar === 2 || scalar === 7 || scalar === 15) return 5;
  if (scalar === 9 || scalar === 12) return 2;
  return 0;
}

function packable(scalar: number | undefined): boolean {
  return scalar !== undefined && scalar !== 9 && scalar !== 12;
}

function scalarPayload(scalar: number, value: unknown): Buffer {
  if (scalar === 9) return Buffer.from(String(value), 'utf8');
  if (scalar === 12) return Buffer.from(value as Uint8Array);
  if (scalar === 1) {
    const out = Buffer.allocUnsafe(8);
    out.writeDoubleLE(Number(value));
    return out;
  }
  if (scalar === 2) {
    const out = Buffer.allocUnsafe(4);
    out.writeFloatLE(Number(value));
    return out;
  }
  if (scalar === 6 || scalar === 16) {
    const out = Buffer.allocUnsafe(8);
    out.writeBigUInt64LE(BigInt(value as string | number | bigint));
    return out;
  }
  if (scalar === 7 || scalar === 15) {
    const out = Buffer.allocUnsafe(4);
    out.writeUInt32LE(Number(value));
    return out;
  }
  if (scalar === 8) return varint(value ? 1 : 0);
  if (scalar === 17) {
    const n = BigInt(value as string | number | bigint);
    return varint((n << 1n) ^ (n >> 63n));
  }
  if (scalar === 18) {
    const n = BigInt(value as string | number | bigint);
    return varint((n << 1n) ^ (n >> 63n));
  }
  return varint(value as number | bigint);
}

function present(value: unknown): boolean {
  return value !== undefined && value !== null;
}

export class ProtoCodec {
  constructor(readonly descriptors: ProtoDescriptorSet) {}

  encode(typeName: string, value: Record<string, unknown> = {}): Buffer {
    const descriptor = this.descriptors.messages[typeName];
    if (!descriptor) return Buffer.alloc(0);
    const chunks: Buffer[] = [];
    for (const field of descriptor.fields) {
      let fieldValue: unknown;
      if (field.oneof) {
        const group = value[field.oneof] as { case?: string; value?: unknown } | undefined;
        if (!group || group.case !== field.localName) continue;
        fieldValue = group.value;
      } else {
        fieldValue = value[field.localName] ?? value[field.name];
      }
      if (!present(fieldValue)) continue;
      const values = field.repeated ? (fieldValue as unknown[]) : [fieldValue];
      if (!values.length) continue;
      if (field.repeated && field.kind === 'scalar' && packable(field.scalar)) {
        const payload = Buffer.concat(values.map((item) => scalarPayload(field.scalar!, item)));
        chunks.push(varint((field.no << 3) | 2), varint(payload.length), payload);
        continue;
      }
      if (field.kind === 'map') {
        for (const [key, mapValue] of Object.entries(fieldValue as Record<string, unknown>)) {
          const entry: Buffer[] = [];
          const keyPayload = scalarPayload(field.map!.keyScalar, key);
          const keyWire = scalarWireType(field.map!.keyScalar);
          entry.push(varint((1 << 3) | keyWire));
          if (keyWire === 2) entry.push(varint(keyPayload.length));
          entry.push(keyPayload);
          const map = field.map!;
          if (map.valueKind === 'message') {
            const payload = this.encode(map.valueMessage!, mapValue as Record<string, unknown>);
            entry.push(varint((2 << 3) | 2), varint(payload.length), payload);
          } else {
            const scalar = map.valueKind === 'enum' ? 13 : map.valueScalar!;
            const payload = scalarPayload(scalar, mapValue);
            const wire = scalarWireType(scalar);
            entry.push(varint((2 << 3) | wire));
            if (wire === 2) entry.push(varint(payload.length));
            entry.push(payload);
          }
          const payload = Buffer.concat(entry);
          chunks.push(varint((field.no << 3) | 2), varint(payload.length), payload);
        }
        continue;
      }
      for (const item of values) {
        let payload: Buffer;
        let wireType: number;
        if (field.kind === 'message') {
          payload = this.encode(field.message!, (item ?? {}) as Record<string, unknown>);
          wireType = 2;
        } else {
          const scalar = field.kind === 'enum' ? 13 : field.scalar!;
          payload = scalarPayload(scalar, item);
          wireType = scalarWireType(scalar);
        }
        chunks.push(varint((field.no << 3) | wireType));
        if (wireType === 2) chunks.push(varint(payload.length));
        chunks.push(payload);
      }
    }
    return Buffer.concat(chunks);
  }

  decode(typeName: string, bytes: Uint8Array): Record<string, any> {
    const buffer = Buffer.from(bytes);
    const descriptor = this.descriptors.messages[typeName];
    if (!descriptor) return {};
    const byNumber = new Map(descriptor.fields.map((field) => [field.no, field]));
    const result: Record<string, any> = {};
    let offset = 0;
    while (offset < buffer.length) {
      const tag = readVarint(buffer, offset);
      offset = tag.offset;
      const number = Number(tag.value >> 3n);
      const wireType = Number(tag.value & 7n);
      const field = byNumber.get(number);
      const read = this.readWireValue(buffer, offset, wireType);
      offset = read.offset;
      if (!field) continue;
      let decoded: unknown;
      if (field.kind === 'message') {
        decoded = this.decode(field.message!, read.payload ?? Buffer.alloc(0));
      } else if (field.kind === 'map') {
        const entry = this.decodeMap(field, read.payload ?? Buffer.alloc(0));
        const map = result[field.localName] ?? {};
        result[field.localName] = map;
        map[entry.key] = entry.value;
        continue;
      } else {
        const scalar = field.kind === 'enum' ? 13 : field.scalar!;
        if (field.repeated && wireType === 2 && packable(scalar)) {
          const packed = read.payload ?? Buffer.alloc(0);
          let packedOffset = 0;
          const values: unknown[] = result[field.localName] ?? [];
          while (packedOffset < packed.length) {
            const item = this.readScalar(packed, packedOffset, scalarWireType(scalar), scalar);
            values.push(item.value);
            packedOffset = item.offset;
          }
          result[field.localName] = values;
          continue;
        }
        decoded = this.scalarFromWire(read, scalar);
      }
      if (field.oneof) result[field.oneof] = { case: field.localName, value: decoded };
      else if (field.repeated) {
        const values = result[field.localName] ?? [];
        result[field.localName] = values;
        values.push(decoded);
      } else result[field.localName] = decoded;
    }
    return result;
  }

  private decodeMap(field: ProtoFieldDescriptor, payload: Buffer): { key: string; value: unknown } {
    let key = '';
    let value: unknown = undefined;
    let offset = 0;
    while (offset < payload.length) {
      const tag = readVarint(payload, offset);
      offset = tag.offset;
      const number = Number(tag.value >> 3n);
      const wire = Number(tag.value & 7n);
      const read = this.readWireValue(payload, offset, wire);
      offset = read.offset;
      if (number === 1) key = String(this.scalarFromWire(read, field.map!.keyScalar));
      if (number === 2) {
        const map = field.map!;
        value =
          map.valueKind === 'message'
            ? this.decode(map.valueMessage!, read.payload ?? Buffer.alloc(0))
            : this.scalarFromWire(read, map.valueKind === 'enum' ? 13 : map.valueScalar!);
      }
    }
    return { key, value };
  }

  private readWireValue(buffer: Buffer, offset: number, wireType: number) {
    if (wireType === 0) {
      const read = readVarint(buffer, offset);
      return { offset: read.offset, varint: read.value };
    }
    if (wireType === 1) return { offset: offset + 8, payload: buffer.subarray(offset, offset + 8) };
    if (wireType === 2) {
      const length = readVarint(buffer, offset);
      const start = length.offset;
      const end = start + Number(length.value);
      if (end > buffer.length) throw new Error('truncated protobuf field');
      return { offset: end, payload: buffer.subarray(start, end) };
    }
    if (wireType === 5) return { offset: offset + 4, payload: buffer.subarray(offset, offset + 4) };
    throw new Error(`unsupported protobuf wire type ${wireType}`);
  }

  private readScalar(buffer: Buffer, offset: number, wireType: number, scalar: number) {
    const read = this.readWireValue(buffer, offset, wireType);
    return { value: this.scalarFromWire(read, scalar), offset: read.offset };
  }

  private scalarFromWire(read: { varint?: bigint; payload?: Buffer }, scalar: number): unknown {
    if (scalar === 9) return (read.payload ?? Buffer.alloc(0)).toString('utf8');
    if (scalar === 12) return Buffer.from(read.payload ?? Buffer.alloc(0));
    if (scalar === 1) return read.payload!.readDoubleLE(0);
    if (scalar === 2) return read.payload!.readFloatLE(0);
    if (scalar === 6 || scalar === 16) return this.numeric(read.payload!.readBigUInt64LE(0));
    if (scalar === 7 || scalar === 15) return read.payload!.readUInt32LE(0);
    const value = read.varint ?? 0n;
    if (scalar === 8) return value !== 0n;
    if (scalar === 17 || scalar === 18) return this.numeric((value >> 1n) ^ -(value & 1n));
    return this.numeric(value);
  }

  private numeric(value: bigint): number | bigint {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
  }
}

export function jsonToProtoValue(value: unknown): Record<string, unknown> {
  if (value === null) return { kind: { case: 'nullValue', value: 0 } };
  if (typeof value === 'number') return { kind: { case: 'numberValue', value } };
  if (typeof value === 'string') return { kind: { case: 'stringValue', value } };
  if (typeof value === 'boolean') return { kind: { case: 'boolValue', value } };
  if (Array.isArray(value)) {
    return {
      kind: { case: 'listValue', value: { values: value.map(jsonToProtoValue) } },
    };
  }
  const fields = Object.fromEntries(
    Object.entries((value ?? {}) as Record<string, unknown>).map(([key, item]) => [
      key,
      jsonToProtoValue(item),
    ]),
  );
  return { kind: { case: 'structValue', value: { fields } } };
}

export function protoValueToJson(value: Record<string, any>): unknown {
  const kind = value.kind as { case?: string; value?: any } | undefined;
  if (!kind) return null;
  if (kind.case === 'nullValue') return null;
  if (kind.case === 'numberValue' || kind.case === 'stringValue' || kind.case === 'boolValue') {
    return kind.value;
  }
  if (kind.case === 'listValue') {
    return (kind.value?.values ?? []).map((item: Record<string, any>) => protoValueToJson(item));
  }
  if (kind.case === 'structValue') {
    return Object.fromEntries(
      Object.entries(kind.value?.fields ?? {}).map(([key, item]) => [
        key,
        protoValueToJson(item as Record<string, any>),
      ]),
    );
  }
  return null;
}
