import { describe, expect, it } from 'vitest';
import { loadProtoDescriptors, ProtoCodec } from '../src/backend/cursor-api/protobuf.js';

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return Object.fromEntries(Object.entries(value));
}

const SUCCESS_PAYLOAD = {
  result: {
    case: 'success',
    value: {
      content: [
        {
          content: {
            case: 'text',
            value: { text: 'tool-ok' },
          },
        },
      ],
    },
  },
};

describe('McpResult success arm codec', () => {
  it('round-trips an mcpResult success message through the live protobuf codec', () => {
    const descriptors = loadProtoDescriptors();
    const mcpResultFields = descriptors.messages['agent.v1.McpResult']?.fields ?? [];
    const successField = mcpResultFields.find((field) => field.localName === 'success');
    expect(successField).toMatchObject({
      no: 1,
      localName: 'success',
      kind: 'message',
      oneof: 'result',
      message: 'agent.v1.McpSuccess',
    });
    expect(mcpResultFields.some((field) => field.localName === 'error')).toBe(true);

    const codec = new ProtoCodec(descriptors);
    const encoded = codec.encode('agent.v1.McpResult', SUCCESS_PAYLOAD);
    expect(encoded.byteLength).toBeGreaterThan(0);

    const decoded = objectRecord(codec.decode('agent.v1.McpResult', encoded), 'decoded McpResult');
    const result = objectRecord(decoded.result, 'McpResult.result');
    expect(result.case).toBe('success');
    const value = objectRecord(result.value, 'McpResult.success');
    if (!Array.isArray(value.content)) {
      throw new Error('McpResult.success.content must be an array');
    }
    const item = objectRecord(value.content[0], 'McpResult.success.content[0]');
    const content = objectRecord(item.content, 'content item');
    expect(content.case).toBe('text');
    expect(objectRecord(content.value, 'text content').text).toBe('tool-ok');

    const envelopeEncoded = codec.encode('agent.v1.AgentClientMessage', {
      message: {
        case: 'execClientMessage',
        value: {
          id: 11,
          execId: 'exec-success',
          message: { case: 'mcpResult', value: SUCCESS_PAYLOAD },
        },
      },
    });
    const envelope = objectRecord(
      codec.decode('agent.v1.AgentClientMessage', envelopeEncoded),
      'AgentClientMessage',
    );
    const exec = objectRecord(objectRecord(envelope.message, 'message').value, 'execClientMessage');
    const mcpResult = objectRecord(objectRecord(exec.message, 'exec message').value, 'mcpResult');
    expect(objectRecord(mcpResult.result, 'enveloped result').case).toBe('success');
  });

  it('does not treat an error-arm mcpResult as success', () => {
    const codec = new ProtoCodec(loadProtoDescriptors());
    const encoded = codec.encode('agent.v1.McpResult', {
      result: { case: 'error', value: { error: 'delegated' } },
    });
    expect(encoded.byteLength).toBeGreaterThan(0);
    const decoded = objectRecord(codec.decode('agent.v1.McpResult', encoded), 'error McpResult');
    const result = objectRecord(decoded.result, 'error result');
    expect(result.case).toBe('error');
    expect(objectRecord(result.value, 'error value').error).toBe('delegated');
  });
});
