import { describe, expect, it } from 'vitest';
import { loadProtoDescriptors, ProtoCodec } from '../src/backend/cursor-api/protobuf.js';

describe('native protobuf field ordering', () => {
  it('writes Run fields in the numeric order used by the installed CLI serializer', () => {
    // This exact byte vector was independently produced by CLI 2026.08.25 AgentRunRequest.toBinary().
    const codec = new ProtoCodec(loadProtoDescriptors());
    const encoded = codec.encode('agent.v1.AgentRunRequest', {
      conversationId: 'c',
      requestedModel: { modelId: 'm' },
    });
    expect(encoded.toString('hex')).toBe('2a01634a030a016d');
  });
});
