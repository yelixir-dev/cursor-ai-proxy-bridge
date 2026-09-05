import { describe, expect, it } from 'vitest';
import { loadProtoDescriptors, ProtoCodec } from '../src/backend/cursor-api/protobuf.js';

const descriptors = loadProtoDescriptors();
const codec = new ProtoCodec(descriptors);
const typeName = 'agent.v1.ReadArgs';

describe('protobuf signed int32', () => {
  it('uses the native ReadArgs int32 offset and uint32 limit contract', () => {
    expect(descriptors.messages[typeName]?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ no: 4, localName: 'offset', kind: 'scalar', scalar: 5 }),
        expect.objectContaining({ no: 5, localName: 'limit', kind: 'scalar', scalar: 13 }),
      ]),
    );
  });

  it.each([-2147483648, -3, -1, 0, 1, 2147483647])(
    'round-trips ReadArgs offset %i as a signed number',
    (offset) => {
      const args = { path: '/workspace/file.ts', toolCallId: 'read-1', offset, limit: 3 };
      const decoded = codec.decode(typeName, codec.encode(typeName, args));
      expect(decoded).toEqual(args);
      expect(typeof decoded.offset).toBe('number');
    },
  );

  it.each<[number, string]>([
    [-3, '20fdffffffffffffffff01'],
    [-2147483648, '2080808080f8ffffffff01'],
  ])('decodes and emits the sign-extended int32 wire value %i', (offset, hex) => {
    const wire = Buffer.from(hex, 'hex');
    expect(codec.decode(typeName, wire)).toEqual({ offset });
    expect(codec.encode(typeName, { offset })).toEqual(wire);
  });

  it('interprets the low 32 bits of a non-sign-extended int32 varint', () => {
    expect(codec.decode(typeName, Buffer.from('20fdffffff0f', 'hex'))).toEqual({ offset: -3 });
  });

  it.each([0, 1, 2147483648, 4294967295])(
    'preserves adjacent uint32 limit %i without signed conversion',
    (limit) => {
      expect(codec.decode(typeName, codec.encode(typeName, { offset: 0, limit }))).toEqual({
        offset: 0,
        limit,
      });
    },
  );
});
