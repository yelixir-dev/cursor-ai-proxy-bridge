import { type RequestTrace, traceStage } from '../../trace.js';
import { CursorBackendError } from '../cursor-cli.js';
import type { ChatCompletionRequest } from '../types.js';
import { handleExecResponse } from './exec-responses.js';
import type { ProtoCodec } from './protobuf.js';
import type { RunEmitter } from './run-types.js';
import { CursorToolStream } from './tool-stream.js';
import { cursorUsageAttribution } from './usage-attribution.js';

type Dict = Record<string, unknown>;

export interface CursorRunMessageOptions {
  readonly codec: ProtoCodec;
  readonly request: ChatCompletionRequest;
  readonly trace?: RequestTrace;
  readonly emit?: RunEmitter;
  readonly blobs: Map<string, Buffer>;
  readonly writeMessage: (message: Dict, compressed?: boolean) => void;
  readonly finish: (error: unknown) => void;
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

  /** Decodes one server frame; returns true when it ended the upstream turn. */
  handle(payload: Buffer): boolean {
    const server = this.options.codec.decode('agent.v1.AgentServerMessage', payload);
    const message = dict(server.message);
    const messageCase = typeof message?.case === 'string' ? message.case : undefined;
    const value = dict(message?.value) ?? {};
    if (messageCase === 'execServerMessage') {
      handleExecResponse(
        {
          codec: this.options.codec,
          request: this.options.request,
          writeMessage: this.options.writeMessage,
          finish: this.options.finish,
          completeTool: (tool) => {
            traceStage(this.options.trace, 'tool_decision');
            this.toolStream.completeExec(tool);
          },
        },
        value,
      );
      return false;
    }
    if (messageCase === 'kvServerMessage') {
      this.handleKv(value);
      return false;
    }
    if (messageCase !== 'interactionUpdate') return false;
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
