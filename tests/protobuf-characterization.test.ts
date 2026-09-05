import { describe, expect, it } from 'vitest';
import {
  jsonToProtoValue,
  loadProtoDescriptors,
  ProtoCodec,
  protoValueToJson,
  type ProtoDescriptorSet,
} from '../src/backend/cursor-api/protobuf.js';

const nativeDescriptors = loadProtoDescriptors();
const descriptors: ProtoDescriptorSet = {
  ...nativeDescriptors,
  messages: {
    ...nativeDescriptors.messages,
    'test.Scalar': {
      fields: [
        { no: 1, name: 'value', localName: 'value', kind: 'scalar', scalar: 5, repeated: false },
      ],
    },
    'test.Packed': {
      fields: [
        { no: 1, name: 'values', localName: 'values', kind: 'scalar', scalar: 5, repeated: true },
      ],
    },
    'test.EnumMap': {
      fields: [
        {
          no: 1,
          name: 'entries',
          localName: 'entries',
          kind: 'map',
          repeated: false,
          map: { keyScalar: 9, valueKind: 'enum', valueEnum: 'google.protobuf.NullValue' },
        },
      ],
    },
  },
};
const codec = new ProtoCodec(descriptors);

function scalarCodec(scalar: number): ProtoCodec {
  return new ProtoCodec({
    ...descriptors,
    messages: {
      ...descriptors.messages,
      'test.Scalar': {
        fields: [
          { no: 1, name: 'value', localName: 'value', kind: 'scalar', scalar, repeated: false },
        ],
      },
    },
  });
}

describe('reflection protobuf characterization', () => {
  it('returns empty results when a message descriptor is unknown', () => {
    // Given an absent descriptor, when encoding and decoding, then no fields exist.
    expect(codec.encode('test.Unknown', { value: 1 })).toEqual(Buffer.alloc(0));
    expect(codec.decode('test.Unknown', Buffer.from('0801', 'hex'))).toEqual({});
  });

  it('skips unknown fields of each supported wire type', () => {
    // Given unknown varint/fixed64/bytes/fixed32 fields before a known offset.
    const wire = Buffer.from('78017900000000000000007a01787d000000002003', 'hex');
    // When decoding, then only the known field survives.
    expect(codec.decode('agent.v1.ReadArgs', wire)).toEqual({ offset: 3 });
  });

  it('preserves explicit defaults, aliases and omission of nullish fields', () => {
    // Given the native snake_case field alias and explicit zero offset.
    const wire = codec.encode('agent.v1.ReadArgs', { tool_call_id: 'r', offset: 0, limit: null });
    // Then only present fields are encoded, in descriptor order.
    expect(wire.toString('hex')).toBe('1201722000');
    expect(codec.decode('agent.v1.ReadArgs', wire)).toEqual({ toolCallId: 'r', offset: 0 });
  });

  it('uses the last recognized oneof member on the wire', () => {
    // Given stringValue followed by boolValue in google.protobuf.Value.
    const decoded = codec.decode('google.protobuf.Value', Buffer.from('1a01782000', 'hex'));
    // Then the last member wins, including a false value.
    expect(decoded).toEqual({ kind: { case: 'boolValue', value: false } });
  });

  it('encodes only the selected oneof case', () => {
    // Given a selected stringValue and an unrelated top-level boolValue.
    const wire = codec.encode('google.protobuf.Value', {
      kind: { case: 'stringValue', value: 'x' },
      boolValue: true,
    });
    // Then the selected member is the sole field.
    expect(wire.toString('hex')).toBe('1a0178');
  });

  it('appends packed and unpacked repeated scalar segments in wire order', () => {
    // Given packed [1, 2] followed by unpacked 3 and another packed 4.
    const decoded = codec.decode('test.Packed', Buffer.from('0a02010208030a0104', 'hex'));
    // Then all segments contribute to one repeated value.
    expect(decoded).toEqual({ values: [1, 2, 3, 4] });
  });

  it('emits packed scalar fields and omits empty arrays', () => {
    // Given a repeated packable scalar descriptor.
    expect(codec.encode('test.Packed', { values: [1, 2, 3] }).toString('hex')).toBe('0a03010203');
    expect(codec.encode('test.Packed', { values: [] })).toEqual(Buffer.alloc(0));
  });

  it('round-trips native repeated strings without packing', () => {
    // Given a native non-packable repeated field.
    const wire = codec.encode('agent.v1.LsArgs', { ignore: ['a', 'b'] });
    // Then each item has its own tag.
    expect(wire.toString('hex')).toBe('120161120162');
    expect(codec.decode('agent.v1.LsArgs', wire)).toEqual({ ignore: ['a', 'b'] });
  });

  it('round-trips native scalar-valued maps', () => {
    // Given native managed-skill resource mappings.
    const input = { resources: { a: 'first', b: 'second' } };
    const decoded = codec.decode(
      'aiserver.v1.ManagedSkill',
      codec.encode('aiserver.v1.ManagedSkill', input),
    );
    // Then both entries retain their string values.
    expect(decoded).toEqual(input);
  });

  it('preserves enum-valued maps and last-entry-wins semantics', () => {
    // Given two enum map entries with the same key.
    const decoded = codec.decode(
      'test.EnumMap',
      Buffer.from('0a050a016110000a050a01611001', 'hex'),
    );
    // Then the later entry replaces the earlier value.
    expect(decoded).toEqual({ entries: { a: 1 } });
    expect(codec.encode('test.EnumMap', { entries: { a: 1 } }).toString('hex')).toBe(
      '0a050a01611001',
    );
  });

  it('preserves an omitted map value as undefined', () => {
    // Given a map entry containing only its key.
    const decoded = codec.decode('test.EnumMap', Buffer.from('0a030a0161', 'hex'));
    // Then absence is not converted into a default enum value.
    expect(decoded).toEqual({ entries: { a: undefined } });
  });

  it.each(
    [null, false, 0, -1.5, '', 'x', [], {}, { a: [null, true, 3, { b: 'x' }] }].map((input) => ({
      input,
    })),
  )(
    'round-trips JSON value $input through real Struct/ListValue/Value descriptors',
    ({ input }) => {
      // Given a JSON-compatible value converted to the protobuf oneof representation.
      const wire = codec.encode('google.protobuf.Value', jsonToProtoValue(input));
      // When decoded through the reflection codec, then the JSON value is unchanged.
      expect(protoValueToJson(codec.decode('google.protobuf.Value', wire))).toEqual(input);
    },
  );

  it('preserves empty and unknown protobuf Value conversion fallbacks', () => {
    // Given missing or unrecognized Value kinds.
    expect(protoValueToJson({})).toBeNull();
    expect(protoValueToJson({ kind: { case: 'unknown', value: 1 } })).toBeNull();
    expect(jsonToProtoValue(undefined)).toEqual({
      kind: { case: 'structValue', value: { fields: {} } },
    });
  });

  it.each<[number, unknown, string]>([
    [1, 1.5, '09000000000000f83f'],
    [2, 1.5, '0d0000c03f'],
    [3, 42, '082a'],
    [4, 9007199254740992n, '088080808080808010'],
    [5, -3, '08fdffffffffffffffff01'],
    [6, 42, '092a00000000000000'],
    [7, 4294967295, '0dffffffff'],
    [8, false, '0800'],
    [9, 'x', '0a0178'],
    [12, Buffer.from([0, 255]), '0a0200ff'],
    [13, 4294967295, '08ffffffff0f'],
    [15, 42, '0d2a000000'],
    [16, 42, '092a00000000000000'],
    [17, -3, '0805'],
    [18, -3, '0805'],
  ])('preserves scalar %i encoding and decoded values', (scalar, value, hex) => {
    // Given a scalar descriptor and independently specified wire bytes.
    const subject = scalarCodec(scalar);
    // When encoding/decoding, then both wire bytes and reflected values are pinned.
    expect(subject.encode('test.Scalar', { value }).toString('hex')).toBe(hex);
    expect(subject.decode('test.Scalar', Buffer.from(hex, 'hex'))).toEqual({ value });
  });

  it.each(['08', '0a0278', '0b'])('rejects malformed wire %s', (hex) => {
    // Given a truncated varint, truncated bytes field, or unsupported wire type.
    expect(() => codec.decode('test.Scalar', Buffer.from(hex, 'hex'))).toThrow();
  });
});
