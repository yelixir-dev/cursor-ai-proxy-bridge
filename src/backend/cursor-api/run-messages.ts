import { type RequestTrace, traceStage } from '../../trace.js';
import { CursorBackendError } from '../cursor-cli.js';
import type { ChatCompletionRequest } from '../types.js';
import { handleExecResponse } from './exec-responses.js';
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

function attemptedToolName(update: Dict): string {
  const toolCall = dict(update.toolCall);
  const tool = dict(toolCall?.tool);
  if (tool?.case !== 'mcpToolCall') return '';
  const args = dict(dict(tool.value)?.args);
  const name = args?.toolName ?? args?.name;
  return typeof name === 'string' ? name : '';
}

export interface CursorRunMessageOptions {
  readonly codec: ProtoCodec;
  readonly request: ChatCompletionRequest;
  readonly trace?: RequestTrace;
  readonly emit?: RunEmitter;
  readonly blobs: Map<string, Buffer>;
  readonly writeMessage: (message: Dict, compressed?: boolean) => void;
  readonly finish: (error: unknown) => void;
  readonly onHeld?: () => void;
  readonly heldExecs?: Array<{ exec: Dict }>;
  readonly onInteraction?: () => void;
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
  text = '';
  usageAttribution = cursorUsageAttribution();

  constructor(private readonly options: CursorRunMessageOptions) {
    this.toolStream = new CursorToolStream(
      options.request.tool_choice === 'none' ? undefined : options.emit,
      new Set((options.request.tools ?? []).map((tool) => tool.function.name)),
      options.request.parallel_tool_calls === false ? 1 : Number.POSITIVE_INFINITY,
    );
  }

  setEmit(emit: RunEmitter | undefined): void {
    this.toolStream.setEmit(this.options.request.tool_choice === 'none' ? undefined : emit);
  }

  /** Decodes one server frame; returns true when it ended the upstream turn. */
  handle(payload: Buffer): boolean {
    const server = this.options.codec.decode('agent.v1.AgentServerMessage', payload);
    const message = dict(server.message);
    const messageCase = typeof message?.case === 'string' ? message.case : undefined;
    const value = dict(message?.value) ?? {};
    if (messageCase === 'execServerMessage') {
      const execCase = dict(value.message)?.case;
      const execOutcome = handleExecResponse(
        {
          codec: this.options.codec,
          request: this.options.request,
          writeMessage: this.options.writeMessage,
          finish: this.options.finish,
          completeTool: (tool) => {
            traceStage(this.options.trace, 'tool_decision');
            this.toolStream.completeExec(tool);
          },
          holdMcp: (exec) => {
            this.options.heldExecs?.push({ exec });
          },
        },
        value,
      );
      if (execCase === 'mcpArgs' && execOutcome === 'held') {
        this.options.onHeld?.();
      }
      return false;
    }
    if (messageCase === 'kvServerMessage') {
      this.handleKv(value);
      return false;
    }
    if (messageCase !== 'interactionUpdate') return false;
    this.options.onInteraction?.();
    const update = dict(dict(value.message)?.value) ?? {};
    const updateCase = dict(value.message)?.case;
    if (updateCase === 'textDelta') {
      const delta = typeof update.text === 'string' ? update.text : '';
      this.text += delta;
      if (delta) this.options.emit?.({ type: 'content', text: delta });
      return false;
    }
    if (updateCase === 'thinkingDelta') {
      const delta = typeof update.text === 'string' ? update.text : '';
      if (delta) this.options.emit?.({ type: 'thinking', text: delta });
      return false;
    }
    if (updateCase === 'toolCallStarted') {
      const declared = new Set(
        (this.options.request.tools ?? []).map((tool) => tool.function.name),
      );
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
      if (!attempted && dict(update.toolCall) && this.options.request.tool_choice === 'required') {
        // toolCall is present but not a nameable mcpToolCall (live builtin
        // attempts decode this way — the descriptor set keeps only
        // mcpToolCall). It can never satisfy tool_choice: required, and the
        // model stalls after it (live capture) until the run timeout. Bare
        // announcements (no toolCall payload yet) pass through; their
        // mcpArgs is guarded separately.
        this.options.finish(
          new CursorUndeclaredToolCallError(
            "tool_choice 'required' cannot be satisfied by a builtin tool call",
          ),
        );
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
