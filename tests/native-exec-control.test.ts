import { describe, expect, it } from 'vitest';
import { handleExecResponse, sendMcpToolResult } from '../src/backend/cursor-api/exec-responses.js';
import { loadProtoDescriptors, ProtoCodec } from '../src/backend/cursor-api/protobuf.js';

describe('native exec stream closure', () => {
  it.each([0, 7])('closes context exec %i after its response', (id) => {
    // Given: an exec substream, as captured from CLI 2026.08.25.
    const writes: Record<string, unknown>[] = [];
    const codec = new ProtoCodec(loadProtoDescriptors());

    // When: the bridge completes its context response.
    handleExecResponse(
      {
        codec,
        request: { model: 'composer-2.5', messages: [{ role: 'user', content: 'WIRE_OK' }] },
        writeMessage: (message) => {
          writes.push(message);
        },
        finish: (error) => {
          throw error;
        },
        completeTool: () => false,
      },
      { id, message: { case: 'requestContextArgs', value: {} } },
    );

    // Then: the response is followed by the native exec control close, not Run termination.
    expect(writes).toHaveLength(2);
    expect(writes[0]).toMatchObject({ message: { case: 'execClientMessage' } });
    expect(writes[1]).toEqual({
      message: {
        case: 'execClientControlMessage',
        value: { message: { case: 'streamClose', value: id ? { id } : {} } },
      },
    });
  });

  it('closes a completed external tool exec after delivering its result', () => {
    // Given: a held external tool result on exec 12.
    const writes: Record<string, unknown>[] = [];

    // When: the OpenAI client supplies the result.
    sendMcpToolResult(
      (message) => {
        writes.push(message);
      },
      { id: 12 },
      'TOOL_RESULT',
    );

    // Then: the result stays first and the corresponding exec closes immediately afterwards.
    expect(writes).toHaveLength(2);
    expect(writes[0]).toMatchObject({ message: { value: { message: { case: 'mcpResult' } } } });
    expect(writes[1]).toEqual({
      message: {
        case: 'execClientControlMessage',
        value: { message: { case: 'streamClose', value: { id: 12 } } },
      },
    });
  });
});
