import { type RequestTrace, traceStage } from '../../trace.js';
import { contentBoundaryDebug, logContentBoundary } from '../content-boundary-debug.js';
import { CursorBackendError } from '../cursor-cli.js';
import { allowedToolNamesForRequest, maximumToolCallsForRequest } from '../tool-call-policy.js';
import type { ChatCompletionRequest, CompletionStreamEvent } from '../types.js';
import {
  builtinStartRouting,
  CursorBuiltinToolCallError,
  logBuiltinToolRouting,
} from './builtin-tool-promotion.js';
import { type HeldToolExec, handleExecResponse } from './exec-responses.js';
import type { NativeConversationContext } from './native-context.js';
import { nativeReadDisposition } from './native-context-read.js';
import type { ProtoCodec } from './protobuf.js';
import type { RunEmitter } from './run-types.js';
import { CursorToolStream } from './tool-stream.js';
import { cursorUsageAttribution } from './usage-attribution.js';

type Dict = Record<string, unknown>;

class CursorUndeclaredToolCallError extends CursorBackendError {
  readonly name = 'CursorUndeclaredToolCallError';

  constructor(detail: string) {
    super(`Model attempted a tool call the request cannot serve: ${detail}`);
  }
}

export { CursorBuiltinToolCallError } from './builtin-tool-promotion.js';

function attemptedToolName(update: Dict): string {
  const toolCall = dict(update.toolCall);
  const tool = dict(toolCall?.tool);
  if (tool?.case !== 'mcpToolCall') return '';
  const args = dict(dict(tool.value)?.args);
  const name = args?.name || args?.toolName;
  return typeof name === 'string' ? name : '';
}

export interface CursorRunMessageOptions {
  readonly codec: ProtoCodec;
  readonly request: ChatCompletionRequest;
  readonly conversationId?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeContext?: NativeConversationContext;
  readonly readSignal?: () => AbortSignal;
  readonly callIdPrefix?: string;
  readonly trace?: RequestTrace;
  readonly emit?: RunEmitter;
  readonly blobs: Map<string, Buffer>;
  readonly writeMessage: (message: Dict, compressed?: boolean) => void;
  readonly finish: (error: unknown) => void;
  readonly onHeld?: () => void;
  readonly heldExecs?: HeldToolExec[];
  readonly onInteraction?: (updateCase: string | undefined) => void;
}

function dict(value: unknown): Dict | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function bytes(value: unknown): Buffer {
  return value instanceof Uint8Array ? Buffer.from(value) : Buffer.alloc(0);
}

export class CursorRunMessages {
  readonly toolStream: CursorToolStream;
  readonly outputEvents: Array<Extract<CompletionStreamEvent, { type: 'content' | 'thinking' }>> =
    [];
  text = '';
  usageAttribution = cursorUsageAttribution();
  private emit: RunEmitter | undefined;
  private textDeltaIndex = 0;

  constructor(private readonly options: CursorRunMessageOptions) {
    this.emit = options.emit;
    this.toolStream = new CursorToolStream(
      options.request.tool_choice === 'none' ? undefined : this.emit,
      allowedToolNamesForRequest(options.request),
      maximumToolCallsForRequest(options.request),
      options.callIdPrefix,
    );
  }

  setEmit(emit: RunEmitter | undefined): void {
    this.emit = emit;
    this.toolStream.setEmit(this.options.request.tool_choice === 'none' ? undefined : emit);
  }

  /** Decodes one server frame; returns true when it ended the upstream turn. */
  handle(payload: Buffer): boolean {
    const server = this.options.codec.decode('agent.v1.AgentServerMessage', payload);
    const message = dict(server.message);
    const messageCase = typeof message?.case === 'string' ? message.case : undefined;
    const value = dict(message?.value) ?? {};
    if (messageCase === 'execServerMessage') {
      const execOutcome = handleExecResponse(
        {
          codec: this.options.codec,
          request: this.options.request,
          conversationId: this.options.conversationId,
          environment: this.options.environment,
          nativeContext: this.options.nativeContext,
          readSignal: this.options.readSignal,
          writeMessage: this.options.writeMessage,
          finish: this.options.finish,
          completeTool: (tool, routing) => {
            traceStage(this.options.trace, 'tool_decision');
            const accepted = this.toolStream.completeExec(tool);
            if (routing) {
              const alias = typeof tool.toolCallId === 'string' ? tool.toolCallId : '';
              logBuiltinToolRouting(routing, {
                runRequestId: this.options.callIdPrefix,
                toolCallIndex: this.toolStream.indexForAlias(alias),
                disposition: accepted ? 'promoted' : 'rejected_undeclared',
              });
            }
            return accepted;
          },
          holdMcp: (held) => {
            this.options.heldExecs?.push(held);
          },
        },
        value,
      );
      if (execOutcome === 'held') {
        this.options.onHeld?.();
      }
      return false;
    }
    if (messageCase === 'kvServerMessage') {
      this.handleKv(value);
      return false;
    }
    if (messageCase !== 'interactionUpdate') return false;
    const update = dict(dict(value.message)?.value) ?? {};
    const rawUpdateCase = dict(value.message)?.case;
    const updateCase = typeof rawUpdateCase === 'string' ? rawUpdateCase : undefined;
    this.options.onInteraction?.(updateCase);
    if (updateCase === 'textDelta') {
      const delta = typeof update.text === 'string' ? update.text : '';
      this.text += delta;
      logContentBoundary(
        contentBoundaryDebug({
          stage: 'cursor_upstream_delta',
          requested_model: this.options.request.model,
          reasoning_effort: this.options.request.reasoning_effort ?? 'default',
          request_id: this.options.callIdPrefix ?? 'unknown',
          chunk_index: this.textDeltaIndex,
          text: delta,
          cumulative_length: this.text.length,
        }),
      );
      this.textDeltaIndex += 1;
      if (delta) {
        const event = { type: 'content' as const, text: delta };
        this.outputEvents.push(event);
        this.emit?.(event);
      }
      return false;
    }
    if (updateCase === 'thinkingDelta') {
      const delta = typeof update.text === 'string' ? update.text : '';
      if (delta) {
        const event = { type: 'thinking' as const, text: delta };
        this.outputEvents.push(event);
        this.emit?.(event);
      }
      return false;
    }
    if (updateCase === 'toolCallStarted') {
      const tool = dict(dict(update.toolCall)?.tool);
      if (
        tool?.case === 'readToolCall' &&
        this.options.nativeContext &&
        nativeReadDisposition(this.options.nativeContext, dict(tool.value)?.args).kind === 'owned'
      )
        return false;
      const declared = allowedToolNamesForRequest(this.options.request);
      if (declared.size === 0 || this.options.request.tool_choice === 'none') {
        // No exec frame follows in this state (live capture: tool_decision
        // then silence until the run timeout), so guard at the interaction
        // level instead of waiting for an mcpArgs that never arrives.
        this.options.finish(
          new CursorUndeclaredToolCallError('the request declares no usable tools'),
        );
        return false;
      }
      const attempted = attemptedToolName(update);
      if (attempted && !declared.has(attempted)) {
        this.options.finish(
          new CursorUndeclaredToolCallError(
            `${JSON.stringify(attempted)} is not among the declared tools`,
          ),
        );
        return false;
      }
      const builtin = builtinStartRouting(this.options.request, update);
      if (builtin) {
        logBuiltinToolRouting(builtin, {
          runRequestId: this.options.callIdPrefix,
          disposition: builtin.mappedOpenAiToolName ? 'declared' : 'rejected_undeclared',
        });
        if (!builtin.mappedOpenAiToolName) {
          this.options.finish(
            new CursorBuiltinToolCallError(
              `Cursor selected builtin ${JSON.stringify(builtin.attemptedToolName)} but the request declares no matching external tool`,
            ),
          );
          return false;
        }
        return false;
      }
      if (
        !attempted &&
        dict(update.toolCall) &&
        (this.options.request.tool_choice === 'required' ||
          typeof this.options.request.tool_choice === 'object')
      ) {
        // toolCall is present but not a nameable mcpToolCall (live builtin
        // attempts decode this way — the descriptor set keeps only
        // mcpToolCall). It can never satisfy tool_choice: required, and the
        // model stalls after it (live capture) until the run timeout. Bare
        // announcements (no toolCall payload yet) pass through; their
        // mcpArgs is guarded separately.
        this.options.finish(new CursorBuiltinToolCallError());
        return false;
      }
      traceStage(this.options.trace, 'tool_decision');
      this.toolStream.start(update);
      return false;
    }
    if (updateCase === 'partialToolCall') {
      this.toolStream.partial(update);
      return false;
    }
    if (updateCase === 'toolCallCompleted') {
      this.toolStream.completeUpdate(update);
      return false;
    }
    if (updateCase === 'turnEnded') {
      this.usageAttribution = cursorUsageAttribution(update);
      return true;
    }
    return false;
  }

  private handleKv(kv: Dict): void {
    const message = dict(kv.message);
    const messageCase = typeof message?.case === 'string' ? message.case : undefined;
    const value = dict(message?.value) ?? {};
    if (messageCase === 'setBlobArgs') {
      const id = bytes(value.blobId).toString('hex');
      this.options.blobs.set(id, bytes(value.blobData));
      this.writeKv(kv, 'setBlobResult', {});
      return;
    }
    if (messageCase === 'getBlobArgs') {
      const id = bytes(value.blobId).toString('hex');
      const blobData = this.options.blobs.get(id);
      this.writeKv(kv, 'getBlobResult', blobData ? { blobData } : {});
      return;
    }
    this.options.finish(
      new CursorBackendError(`Cannot answer Cursor KV message ${messageCase ?? 'unknown'}`),
    );
  }

  private writeKv(kv: Dict, messageCase: string, value: Dict): void {
    this.options.writeMessage({
      message: {
        case: 'kvClientMessage',
        value: { id: kv.id, message: { case: messageCase, value } },
      },
    });
  }
}
