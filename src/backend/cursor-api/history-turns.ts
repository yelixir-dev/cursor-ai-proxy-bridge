import { createHash } from 'node:crypto';
import type { ChatMessage, ToolCall } from '../types.js';
import { parsedArguments, deterministicUuid, type CursorBlobStore } from './history-shared.js';
import { jsonToProtoValue, type ProtoCodec } from './protobuf.js';

const BRIDGE_PROVIDER_ID = 'bridge';

/** Native shape: turns are UI/checkpoint metadata grouped per user message. */
export function buildConversationTurns(
  history: readonly ChatMessage[],
  blobs: CursorBlobStore,
  codec: Pick<ProtoCodec, 'encode'>,
): Buffer[] {
  const results = new Map<string, ChatMessage>();
  for (const message of history) {
    if (message.role === 'tool' && message.tool_call_id) results.set(message.tool_call_id, message);
  }
  const toolCallStepBlob = (call: ToolCall, result: ChatMessage | undefined): Buffer => {
    const args = Object.fromEntries(
      Object.entries(parsedArguments(call)).map(([key, value]) => [key, jsonToProtoValue(value)]),
    );
    const mcpCall: Record<string, unknown> = {
      args: {
        name: call.function.name,
        args,
        toolCallId: call.id,
        providerIdentifier: BRIDGE_PROVIDER_ID,
        toolName: call.function.name,
      },
    };
    if (result) {
      mcpCall.result = {
        result: {
          case: 'success',
          value: { content: [{ content: { case: 'text', value: { text: result.content } } }] },
        },
      };
    }
    return blobs.store(
      codec.encode('agent.v1.ConversationStep', {
        message: {
          case: 'toolCall',
          value: { tool: { case: 'mcpToolCall', value: mcpCall }, toolCallId: call.id },
        },
      }),
    );
  };
  const turns: Buffer[] = [];
  let steps: Buffer[] = [];
  let userMessageId: Buffer | undefined;
  const finishTurn = () => {
    if (userMessageId === undefined) return;
    turns.push(
      blobs.store(
        codec.encode('agent.v1.ConversationTurnStructure', {
          turn: { case: 'agentConversationTurn', value: { userMessage: userMessageId, steps } },
        }),
      ),
    );
  };
  for (const message of history) {
    if (message.role === 'user') {
      if (userMessageId !== undefined) finishTurn();
      const text = message.content.trim();
      // Native skips empty-user turns entirely: their followers stay root-prompt-only.
      userMessageId = text
        ? blobs.store(
            codec.encode('agent.v1.UserMessage', {
              text,
              messageId: deterministicUuid(
                `u:${turns.length}:${createHash('sha256').update(text).digest('hex')}`,
              ),
            }),
          )
        : undefined;
      steps = [];
      continue;
    }
    if (userMessageId === undefined) continue;
    if (message.role !== 'assistant') continue;
    if (message.content) {
      steps.push(
        blobs.store(
          codec.encode('agent.v1.ConversationStep', {
            message: { case: 'assistantMessage', value: { text: message.content } },
          }),
        ),
      );
    }
    for (const call of message.tool_calls ?? []) {
      steps.push(toolCallStepBlob(call, results.get(call.id)));
    }
  }
  if (userMessageId !== undefined) finishTurn();
  return turns;
}
