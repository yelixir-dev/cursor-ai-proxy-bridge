export interface WireValue {
  readonly offset: number;
  readonly varint?: bigint;
  readonly payload?: Buffer;
}

export function varint(value: number | bigint): Buffer {
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

export function readVarint(buffer: Buffer, start: number): { value: bigint; offset: number } {
  let value = 0n;
  let shift = 0n;
  let offset = start;
  while (offset < buffer.length && shift <= 70n) {
    const byte = buffer.readUInt8(offset++);
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, offset };
    shift += 7n;
  }
  throw new Error('invalid protobuf varint');
}

export function scalarWireType(scalar: number): number {
  if (scalar === 1 || scalar === 6 || scalar === 16) return 1;
  if (scalar === 2 || scalar === 7 || scalar === 15) return 5;
  if (scalar === 9 || scalar === 12) return 2;
  return 0;
}

export function packable(scalar: number): boolean {
  return scalar !== 9 && scalar !== 12;
}

function integer(value: unknown): bigint {
  if (
    typeof value === 'bigint' ||
    typeof value === 'number' ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return BigInt(value);
  }
  throw new TypeError('protobuf integer requires a primitive value');
}

function bytes(value: unknown): Buffer {
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (typeof value === 'string' || value instanceof Uint8Array) return Buffer.from(value);
  if (Array.isArray(value)) {
    const items: unknown[] = value;
    return Buffer.from(items.map(Number));
  }
  throw new TypeError('protobuf bytes require a byte buffer');
}

export function scalarPayload(scalar: number, value: unknown): Buffer {
  if (scalar === 9) return Buffer.from(String(value), 'utf8');
  if (scalar === 12) return bytes(value);
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
    out.writeBigUInt64LE(integer(value));
    return out;
  }
  if (scalar === 7 || scalar === 15) {
    const out = Buffer.allocUnsafe(4);
    out.writeUInt32LE(Number(value));
    return out;
  }
  if (scalar === 8) return varint(value ? 1 : 0);
  if (scalar === 17 || scalar === 18) {
    const n = integer(value);
    return varint((n << 1n) ^ (n >> 63n));
  }
  return varint(typeof value === 'bigint' ? value : Number(value));
}

export function readWireValue(buffer: Buffer, offset: number, wireType: number): WireValue {
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

function numeric(value: bigint): number | bigint {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
}

export function scalarFromWire(read: WireValue, scalar: number): unknown {
  if (scalar === 9) return (read.payload ?? Buffer.alloc(0)).toString('utf8');
  if (scalar === 12) return Buffer.from(read.payload ?? Buffer.alloc(0));
  if (
    scalar === 1 ||
    scalar === 2 ||
    scalar === 6 ||
    scalar === 16 ||
    scalar === 7 ||
    scalar === 15
  ) {
    const payload = read.payload;
    if (!payload) throw new TypeError('protobuf fixed-width scalar requires a payload');
    if (scalar === 1) return payload.readDoubleLE(0);
    if (scalar === 2) return payload.readFloatLE(0);
    if (scalar === 6 || scalar === 16) return numeric(payload.readBigUInt64LE(0));
    return payload.readUInt32LE(0);
  }
  const value = read.varint ?? 0n;
  if (scalar === 5) return Number(BigInt.asIntN(32, value));
  if (scalar === 8) return value !== 0n;
  if (scalar === 17 || scalar === 18) return numeric((value >> 1n) ^ -(value & 1n));
  return numeric(value);
}
