import { basename } from 'node:path';
import { describe, expect, it } from 'vitest';
import { requestContextResult } from '../src/backend/cursor-api/mapper.js';
import { scenario, success } from './support/native-parity-http.js';
import { execReplies, object, oneof, runRequest } from './support/native-parity-wire.js';

describe('native request-context provenance', () => {
  it('uses the configured CLI data root and the actual conversation identifier', () => {
    const conversationId = '8cf5ee80-5a78-4e22-bfd4-3d30f91d8ba8';
    const result: unknown = Reflect.apply(requestContextResult, undefined, [
      { model: 'composer-2.5', messages: [{ role: 'user', content: 'WIRE_OK' }] },
      '/workspace/native-fixture',
      { CURSOR_DATA_DIR: '/data/native-fixture', SHELL: '/bin/zsh' },
      conversationId,
    ]);
    expect(result).toMatchObject({
      result: {
        value: {
          requestContext: {
            env: {
              projectFolder: '/data/native-fixture/projects/workspace-native-fixture',
              agentConversationNotesFolder:
                '/data/native-fixture/projects/workspace-native-fixture/agent-notes/' +
                conversationId,
            },
          },
        },
      },
    });
  });

  it('correlates context notes with the Run conversation over the HTTP path', async () => {
    await scenario('conversation-context-correlation', async (f) => {
      f.transport.plans.push('text');
      success(
        await f.request('/v1/chat/completions', {
          model: 'composer-2.5',
          messages: [{ role: 'user', content: 'WIRE_OK' }],
        }),
      );
      const run = f.transport.runs[0];
      if (!run) throw new Error('missing Run');
      const response = object(execReplies(run, 'requestContextResult')[0]);
      const context = object(oneof(response.result).value.requestContext);
      const environment = object(context.env);
      expect(basename(String(environment.agentConversationNotesFolder))).toBe(
        runRequest(run).conversationId,
      );
    });
  });
});
