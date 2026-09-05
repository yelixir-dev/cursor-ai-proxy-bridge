import {
  mapValueDescriptor,
  type ProtoDescriptorSet,
  type ProtoMapDescriptor,
  type ProtoValueDescriptor,
  unreachable,
} from './protobuf-descriptors.js';
import { array, isRecord, record } from './protobuf-values.js';
import {
  packable,
  readVarint,
  readWireValue,
  scalarFromWire,
  scalarPayload,
  scalarWireType,
  varint,
  type WireValue,
} from './protobuf-wire.js';

export {
  loadProtoDescriptors,
  type ProtoDescriptorSet,
  type ProtoFieldDescriptor,
} from './protobuf-descriptors.js';
export { jsonToProtoValue, protoValueToJson } from './protobuf-values.js';

function fieldBytes(no: number, payload: Buffer, wireType: number): Buffer {
  const tag = varint((no << 3) | wireType);
  return Buffer.concat(wireType === 2 ? [tag, varint(payload.length), payload] : [tag, payload]);
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
        const group = value[field.oneof];
        if (!isRecord(group) || group.case !== field.localName) continue;
        fieldValue = group.value;
      } else {
        fieldValue = value[field.localName] ?? value[field.name];
      }
      if (fieldValue === undefined || fieldValue === null) continue;
      const values = field.repeated ? array(fieldValue) : [fieldValue];
      if (!values.length) continue;
      switch (field.kind) {
        case 'map':
          for (const [key, mapValue] of Object.entries(record(fieldValue))) {
            const keyPayload = scalarPayload(field.map.keyScalar, key);
            const encoded = this.encodeValue(mapValueDescriptor(field.map), mapValue);
            const payload = Buffer.concat([
              fieldBytes(1, keyPayload, scalarWireType(field.map.keyScalar)),
              fieldBytes(2, encoded.payload, encoded.wireType),
            ]);
            chunks.push(fieldBytes(field.no, payload, 2));
          }
          break;
        case 'scalar':
          if (field.repeated && packable(field.scalar)) {
            const payload = Buffer.concat(values.map((item) => scalarPayload(field.scalar, item)));
            chunks.push(fieldBytes(field.no, payload, 2));
            break;
          }
          for (const item of values) {
            const encoded = this.encodeValue(field, item);
            chunks.push(fieldBytes(field.no, encoded.payload, encoded.wireType));
          }
          break;
        case 'enum':
        case 'message':
          for (const item of values) {
            const encoded = this.encodeValue(field, item);
            chunks.push(fieldBytes(field.no, encoded.payload, encoded.wireType));
          }
          break;
        default:
          unreachable(field);
      }
    }
    return Buffer.concat(chunks);
  }

  decode(typeName: string, bytes: Uint8Array): Record<string, unknown> {
    const buffer = Buffer.from(bytes);
    const descriptor = this.descriptors.messages[typeName];
    if (!descriptor) return {};
    const byNumber = new Map(descriptor.fields.map((field) => [field.no, field]));
    // Typed accumulators own repeated/map mutations; result remains a dynamic message boundary.
    const result: Record<string, unknown> = {};
    const repeated = new Map<string, unknown[]>();
    const maps = new Map<string, Record<string, unknown>>();
    let offset = 0;
    while (offset < buffer.length) {
      const tag = readVarint(buffer, offset);
      const number = Number(tag.value >> 3n);
      const wireType = Number(tag.value & 7n);
      const field = byNumber.get(number);
      const read = readWireValue(buffer, tag.offset, wireType);
      offset = read.offset;
      if (!field) continue;
      let decoded: unknown;
      switch (field.kind) {
        case 'map': {
          const entry = this.decodeMap(field.map, read.payload ?? Buffer.alloc(0));
          const map = maps.get(field.localName) ?? {};
          maps.set(field.localName, map);
          result[field.localName] = map;
          map[entry.key] = entry.value;
          continue;
        }
        case 'scalar':
        case 'enum': {
          const scalar = field.kind === 'enum' ? 13 : field.scalar;
          if (field.repeated && wireType === 2 && packable(scalar)) {
            const packed = read.payload ?? Buffer.alloc(0);
            let packedOffset = 0;
            const values = repeated.get(field.localName) ?? [];
            while (packedOffset < packed.length) {
              const item = readWireValue(packed, packedOffset, scalarWireType(scalar));
              values.push(scalarFromWire(item, scalar));
              packedOffset = item.offset;
            }
            repeated.set(field.localName, values);
            result[field.localName] = values;
            continue;
          }
          decoded = scalarFromWire(read, scalar);
          break;
        }
        case 'message':
          decoded = this.decode(field.message, read.payload ?? Buffer.alloc(0));
          break;
        default:
          unreachable(field);
      }
      if (field.oneof) result[field.oneof] = { case: field.localName, value: decoded };
      else if (field.repeated) {
        const values = repeated.get(field.localName) ?? [];
        repeated.set(field.localName, values);
        result[field.localName] = values;
        values.push(decoded);
      } else result[field.localName] = decoded;
    }
    return result;
  }

  private encodeValue(
    field: ProtoValueDescriptor,
    value: unknown,
  ): { payload: Buffer; wireType: number } {
    switch (field.kind) {
      case 'message':
        return { payload: this.encode(field.message, record(value ?? {})), wireType: 2 };
      case 'enum':
        return { payload: scalarPayload(13, value), wireType: 0 };
      case 'scalar':
        return {
          payload: scalarPayload(field.scalar, value),
          wireType: scalarWireType(field.scalar),
        };
      default:
        return unreachable(field);
    }
  }

  private decodeValue(field: ProtoValueDescriptor, read: WireValue): unknown {
    switch (field.kind) {
      case 'message':
        return this.decode(field.message, read.payload ?? Buffer.alloc(0));
      case 'enum':
        return scalarFromWire(read, 13);
      case 'scalar':
        return scalarFromWire(read, field.scalar);
      default:
        return unreachable(field);
    }
  }

  private decodeMap(map: ProtoMapDescriptor, payload: Buffer): { key: string; value: unknown } {
    let key = '';
    let value: unknown;
    let offset = 0;
    while (offset < payload.length) {
      const tag = readVarint(payload, offset);
      const number = Number(tag.value >> 3n);
      const wire = Number(tag.value & 7n);
      const read = readWireValue(payload, tag.offset, wire);
      offset = read.offset;
      if (number === 1) key = String(scalarFromWire(read, map.keyScalar));
      if (number === 2) value = this.decodeValue(mapValueDescriptor(map), read);
    }
    return { key, value };
  }
}
