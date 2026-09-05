import { describe, expect, it } from 'vitest';
import { buildCursorHistory } from '../src/backend/cursor-api/history.js';
import { loadProtoDescriptors, ProtoCodec } from '../src/backend/cursor-api/protobuf.js';

const codec = new ProtoCodec(loadProtoDescriptors());
describe('captured native first-turn history', () => {
  it('sends no invented root prompt on a fresh user-only conversation', () => {
    const history = buildCursorHistory(
      {
        model: 'composer-2.5',
        messages: [{ role: 'user', content: 'WIRE_OK' }],
      },
      codec,
    );
    expect(history.conversationState.rootPromptMessagesJson).toEqual([]);
    expect(history.action).toEqual({
      action: {
        case: 'userMessageAction',
        value: {
          userMessage: {
            text: 'WIRE_OK',
            messageId: expect.any(String),
            selectedContext: {},
            mode: 1,
          },
        },
      },
    });
  });

  it('preserves an explicit caller system message instead of manufacturing or dropping it', () => {
    const supplied = 'USER_SYSTEM_7319';
    const history = buildCursorHistory(
      {
        model: 'composer-2.5',
        messages: [
          { role: 'system', content: supplied },
          { role: 'user', content: 'WIRE_OK' },
        ],
      },
      codec,
    );
    expect(history.conversationState.rootPromptMessagesJson).toHaveLength(1);
    const blob = history.conversationState.rootPromptMessagesJson[0];
    if (!blob) throw new Error('missing explicit system blob');
    expect(JSON.parse(history.blobs.get(blob.toString('hex'))?.toString() ?? 'null')).toEqual({
      role: 'system',
      content: supplied,
    });
  });
});
