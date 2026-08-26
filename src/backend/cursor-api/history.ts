import { randomUUID } from 'node:crypto';
import type { ChatCompletionRequest, ChatMessage } from '../types.js';
import { ToolHistoryValidationError, assertValidToolHistory } from '../tool-history.js';
import { CursorBlobStore, parsedArguments } from './history-shared.js';
import { buildConversationTurns } from './history-turns.js';
import type { ProtoCodec } from './protobuf.js';

export const AGENT_MODE = {
  UNSPECIFIED: 0,
  AGENT: 1,
  ASK: 2,
} as const;

const DEFAULT_SYSTEM_PROMPT = 'You are a helpful assistant.';

export interface CursorHistory {
  readonly conversationState: {
    rootPromptMessagesJson: readonly Buffer[];
    turns: readonly Buffer[];
  };
  readonly action: Record<string, unknown>;
  readonly blobs: ReadonlyMap<string, Buffer>;
}

type TextPart = { readonly type: 'text'; readonly text: string };
type ToolCallPart = {
  readonly type: 'tool-call';
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
};
type ToolResultPart = {
  readonly type: 'tool-result';
  readonly toolCallId: string;
  readonly toolName: string;
  readonly result: string;
};
type RootPromptEntry =
  | { readonly role: 'system'; readonly content: string }
  | { readonly role: 'user'; readonly content: readonly TextPart[] }
  | { readonly role: 'assistant'; readonly content: readonly (TextPart | ToolCallPart)[] }
  | { readonly role: 'tool'; readonly id: string; readonly content: readonly ToolResultPart[] };

function nativeToolInstruction(request: ChatCompletionRequest): string {
  if (!request.tools?.length) return '';
  if (request.tool_choice === 'none') {
    return 'Do not call any available tool. Answer directly in ordinary text.';
  }
  if (typeof request.tool_choice === 'object') {
    return `Call exactly the MCP/OpenAI tool ${JSON.stringify(request.tool_choice.function.name)}. Do not answer directly or use Cursor built-in Read, Shell, LS, Grep, or Web tools.`;
  }
  if (request.tool_choice === 'required') {
    return 'Call at least one MCP/OpenAI tool listed in this request by its exact function name. Do not answer directly or use Cursor built-in Read, Shell, LS, Grep, or Web tools.';
  }
  return 'When a tool is needed, call only an MCP/OpenAI tool listed in this request by its exact function name. Do not use Cursor built-in Read, Shell, LS, Grep, or Web tools. Never say tool execution is delegated; emit a tool call instead.';
}

/** Bridge tool-scheduling guidance rides as a trailing root-prompt system entry. */
function guidanceFor(request: ChatCompletionRequest): string {
  const parallelNote =
    request.tools?.length && request.parallel_tool_calls === false
      ? '\nReturn at most one tool call.'
      : '';
  return `${nativeToolInstruction(request)}${parallelNote}`.trim();
}

/** assertValidToolHistory already guarantees this; narrowing keeps the type honest. */
function requiredToolCallId(message: ChatMessage): string {
  if (message.tool_call_id === undefined) {
    throw new ToolHistoryValidationError('Tool result messages require tool_call_id');
  }
  return message.tool_call_id;
}

/** Native shape: Cursor builds the model prompt from rootPromptMessagesJson blobs. */
function rootPromptEntries(
  request: ChatCompletionRequest,
  history: readonly ChatMessage[],
): RootPromptEntry[] {
  const names = new Map<string, string>();
  for (const message of history) {
    for (const call of message.tool_calls ?? []) names.set(call.id, call.function.name);
  }
  const entries: RootPromptEntry[] = [];
  for (const message of history) {
    if (message.role === 'system' || message.role === 'developer') {
      const text = message.content.trim();
      if (text) entries.push({ role: 'system', content: text });
    } else if (message.role === 'user') {
      // Text-only bridge: image parts are already flattened to text upstream.
      const text = message.content.trim();
      if (text) entries.push({ role: 'user', content: [{ type: 'text', text }] });
    } else if (message.role === 'assistant') {
      const content: Array<TextPart | ToolCallPart> = [];
      if (message.content) content.push({ type: 'text', text: message.content });
      for (const call of message.tool_calls ?? []) {
        // Thinking is never replayed; this bridge carries no thinking content.
        content.push({
          type: 'tool-call',
          toolCallId: call.id,
          toolName: call.function.name,
          args: parsedArguments(call),
        });
      }
      if (content.length) entries.push({ role: 'assistant', content });
    } else {
      // Even an empty tool result is replayed: dropping it would orphan the call.
      const toolCallId = requiredToolCallId(message);
      entries.push({
        role: 'tool',
        id: toolCallId,
        content: [
          {
            type: 'tool-result',
            toolCallId,
            toolName: names.get(toolCallId) ?? 'unknown_tool',
            result: message.content,
          },
        ],
      });
    }
  }
  if (!entries.some((entry) => entry.role === 'system')) {
    entries.unshift({ role: 'system', content: DEFAULT_SYSTEM_PROMPT });
  }
  const guidance = guidanceFor(request);
  if (guidance) entries.push({ role: 'system', content: guidance });
  return entries;
}

function actionFor(request: ChatCompletionRequest): Record<string, unknown> {
  const active = request.messages.at(-1);
  const text = active?.role === 'user' ? active.content.trim() : '';
  if (!text) return { action: { case: 'resumeAction', value: {} } };
  return {
    action: {
      case: 'userMessageAction',
      value: {
        userMessage: {
          text,
          messageId: randomUUID(),
          selectedContext: {},
          mode:
            request.tools?.length && request.tool_choice !== 'none'
              ? AGENT_MODE.AGENT
              : AGENT_MODE.ASK,
          conversationStateBlobId: Buffer.alloc(0),
        },
      },
    },
  };
}

export function buildCursorHistory(
  request: ChatCompletionRequest,
  codec: Pick<ProtoCodec, 'encode'>,
): CursorHistory {
  assertValidToolHistory(request.messages);
  const blobs = new CursorBlobStore();
  const activeIndex = request.messages.at(-1)?.role === 'user' ? request.messages.length - 1 : -1;
  const history = request.messages.slice(0, activeIndex >= 0 ? activeIndex : undefined);
  const rootPromptMessagesJson = rootPromptEntries(request, history).map((entry) =>
    blobs.store(Buffer.from(JSON.stringify(entry), 'utf8')),
  );
  const turns = buildConversationTurns(history, blobs, codec);
  return {
    conversationState: { rootPromptMessagesJson, turns },
    action: actionFor(request),
    blobs: blobs.entries,
  };
}
