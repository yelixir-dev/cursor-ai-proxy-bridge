import { CursorBackendError } from '../cursor-cli.js';
import type { ChatCompletionRequest } from '../types.js';
import {
  type BuiltinToolRoutingDebug,
  CursorBuiltinToolCallError,
  promoteBuiltinExec,
} from './builtin-tool-promotion.js';
import {
  builtinToolResultReply,
  emptyBuiltinResult,
  type PromotedBuiltinExecContext,
} from './builtin-tool-results.js';
import { nativeToolDefinition, requestContextResult } from './mapper.js';
import type { NativeConversationContext } from './native-context.js';
import { serveNativeContextRead } from './native-context-read.js';
import type { ProtoCodec } from './protobuf.js';

type Dict = Record<string, unknown>;

export interface ExecResponseContext {
  readonly codec: ProtoCodec;
  readonly request: ChatCompletionRequest;
  readonly conversationId?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeContext?: NativeConversationContext;
  readonly readSignal?: () => AbortSignal;
  readonly writeMessage: (message: Dict, compressed?: boolean) => void;
  readonly finish: (error: unknown) => void;
  readonly completeTool: (value: Dict, routing?: BuiltinToolRoutingDebug) => boolean;
  readonly holdMcp?: (held: HeldToolExec) => void;
}

export interface HeldToolExec {
  readonly exec: Dict;
  readonly startedAt?: number;
  readonly promotedBuiltin?: PromotedBuiltinExecContext;
}

interface ExecReply {
  readonly exec: Dict;
  readonly messageCase: string;
  readonly value: Dict;
  readonly compressed?: boolean;
  readonly localExecutionTimeMs?: number;
  readonly startedAt?: number;
  readonly omitExecId?: boolean;
}

function dict(value: unknown): Dict | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function sendExec(
  writeMessage: (message: Dict, compressed?: boolean) => void,
  reply: ExecReply,
): void {
  const execValue: Dict = {
    ...(reply.exec.id ? { id: reply.exec.id } : {}),
    message: { case: reply.messageCase, value: reply.value },
    localExecutionTimeMs:
      reply.startedAt === undefined
        ? reply.localExecutionTimeMs
        : Math.round(performance.now() - reply.startedAt),
  };
  if (reply.omitExecId !== true) execValue.execId = reply.exec.execId;
  writeMessage(
    {
      message: {
        case: 'execClientMessage',
        value: execValue,
      },
    },
    reply.compressed ?? false,
  );
  writeMessage(
    {
      message: {
        case: 'execClientControlMessage',
        value: {
          message: {
            case: 'streamClose',
            value: reply.exec.id ? { id: reply.exec.id } : {},
          },
        },
      },
    },
    false,
  );
}

function allowedMcpToolName(request: ChatCompletionRequest, value: Dict): boolean {
  const name = value.name || value.toolName;
  if (typeof name !== 'string' || name.length === 0) return false;
  return (request.tools ?? []).some((tool) => tool.function.name === name);
}

export function sendMcpToolResult(
  writeMessage: (message: Dict, compressed?: boolean) => void,
  exec: Dict,
  text: string,
  startedAt = performance.now(),
): void {
  sendExec(writeMessage, {
    exec,
    messageCase: 'mcpResult',
    value: {
      result: {
        case: 'success',
        value: {
          content: [{ content: { case: 'text', value: { text } } }],
        },
      },
    },
    omitExecId: true,
    startedAt,
    compressed: false,
  });
}

export function sendHeldToolResult(
  writeMessage: (message: Dict, compressed?: boolean) => void,
  held: HeldToolExec,
  text: string,
): void {
  if (!held.promotedBuiltin) {
    sendMcpToolResult(writeMessage, held.exec, text, held.startedAt);
    return;
  }
  const reply = builtinToolResultReply(held.promotedBuiltin, text);
  if (!reply) {
    throw new CursorBackendError(
      `Cannot answer promoted Cursor exec message ${held.promotedBuiltin.execCase}`,
    );
  }
  sendExec(writeMessage, { exec: held.exec, ...reply, compressed: false });
}

export function handleExecResponse(
  context: ExecResponseContext,
  exec: Dict,
): 'held' | 'ignored' | undefined {
  const startedAt = performance.now();
  const message = dict(exec.message);
  const execCase = typeof message?.case === 'string' ? message.case : undefined;
  const value = dict(message?.value) ?? {};
  if (!execCase) return;
  if (execCase === 'requestContextArgs') {
    sendExec(context.writeMessage, {
      exec,
      messageCase: 'requestContextResult',
      value: requestContextResult(
        context.request,
        process.cwd(),
        context.environment,
        context.conversationId,
        context.nativeContext?.context,
      ),
      compressed: true,
      omitExecId: true,
      startedAt,
    });
    return;
  }
  if (execCase === 'readArgs' && context.nativeContext) {
    if (
      serveNativeContextRead({
        context: context.nativeContext,
        args: value,
        signal: context.readSignal?.(),
        reply: (result) =>
          sendExec(context.writeMessage, {
            exec,
            messageCase: 'readResult',
            value: result,
            omitExecId: true,
            startedAt,
          }),
        finish: context.finish,
      })
    )
      return;
  }
  if (execCase === 'mcpArgs') {
    const name = value.name || value.toolName;
    if (typeof name !== 'string' || name.length === 0) {
      // Fail fast instead of leaving the server waiting on an unanswered
      // exec until the run timeout burns the full window.
      sendExec(context.writeMessage, {
        exec,
        messageCase: 'mcpResult',
        value: {
          result: { case: 'error', value: { error: 'Malformed mcpArgs: missing tool name' } },
        },
        startedAt,
        omitExecId: true,
        compressed: false,
      });
      return 'ignored';
    }
    if (!allowedMcpToolName(context.request, value)) {
      sendExec(context.writeMessage, {
        exec,
        messageCase: 'mcpResult',
        value: {
          result: {
            case: 'error',
            value: { error: `Tool ${JSON.stringify(name)} is not declared in this request` },
          },
        },
        startedAt,
        omitExecId: true,
        compressed: false,
      });
      return 'ignored';
    }
    if (!context.completeTool(value)) {
      sendExec(context.writeMessage, {
        exec,
        messageCase: 'mcpResult',
        value: {
          result: {
            case: 'error',
            value: { error: 'Tool call could not be reconciled with the declared tools' },
          },
        },
        startedAt,
        omitExecId: true,
        compressed: false,
      });
      return 'ignored';
    }
    context.holdMcp?.({ exec, startedAt });
    return 'held';
  }
  if (execCase === 'mcpAllowlistPrecheckArgs') {
    sendExec(context.writeMessage, {
      exec,
      messageCase: 'mcpAllowlistPrecheckResult',
      value: { allowlisted: true },
      omitExecId: true,
      startedAt,
    });
    return;
  }
  if (execCase === 'mcpStateExecArgs') {
    // One virtual server: matching IDs select bridge; empty or unmatched IDs fall
    // back to all servers. Native kickOnly requests also return this same state.
    const advertised = context.request.tool_choice === 'none' ? [] : (context.request.tools ?? []);
    sendExec(context.writeMessage, {
      exec,
      messageCase: 'mcpStateExecResult',
      omitExecId: true,
      startedAt,
      value: {
        result: {
          case: 'success',
          value:
            advertised.length === 0
              ? { servers: [] }
              : {
                  servers: [
                    {
                      serverName: 'bridge',
                      serverIdentifier: 'bridge',
                      tools: advertised.map(nativeToolDefinition),
                      status: 'connected',
                    },
                  ],
                },
        },
      },
    });
    return;
  }
  if (execCase === 'listMcpResourcesExecArgs') {
    sendExec(context.writeMessage, {
      exec,
      messageCase: 'listMcpResourcesExecResult',
      value: { result: { case: 'success', value: { resources: [] } } },
      omitExecId: true,
      startedAt,
    });
    return;
  }
  const promoted = promoteBuiltinExec(context.request, exec, execCase, value);
  if (promoted) {
    if ((context.request.tools ?? []).length === 0) {
      const resultCase =
        execCase === 'shellStreamArgs'
          ? 'shellResult'
          : execCase.replace(/Args$/, 'Result').replace(/Request$/, 'Response');
      const result = emptyBuiltinResult(context.codec, resultCase);
      if (!result) {
        context.finish(new CursorBackendError(`Cannot answer Cursor exec message ${execCase}`));
        return 'ignored';
      }
      sendExec(context.writeMessage, { exec, messageCase: resultCase, value: result });
      return 'ignored';
    }
    if (!promoted.debug.mappedOpenAiToolName) {
      context.finish(
        new CursorBuiltinToolCallError(
          `Cursor selected builtin ${JSON.stringify(promoted.debug.attemptedToolName)} but the request declares no matching external tool`,
        ),
      );
      return 'ignored';
    }
    if (!context.completeTool(promoted.tool, promoted.debug)) {
      context.finish(
        new CursorBuiltinToolCallError(
          `Cursor builtin ${JSON.stringify(promoted.debug.attemptedToolName)} could not be promoted to the declared external tool`,
        ),
      );
      return 'ignored';
    }
    context.holdMcp?.({ exec, promotedBuiltin: { execCase, args: value } });
    return 'held';
  }
  context.finish(new CursorBackendError(`Cannot answer Cursor exec message ${execCase}`));
  return 'ignored';
}
