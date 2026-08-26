import type { ChatCompletionRequest } from '../types.js';
import { CursorBackendError } from '../cursor-cli.js';
import {
  CursorBuiltinToolCallError,
  logBuiltinToolRouting,
  promoteBuiltinExec,
} from './builtin-tool-promotion.js';
import {
  builtinToolResultReply,
  emptyBuiltinResult,
  type PromotedBuiltinExecContext,
} from './builtin-tool-results.js';
import { nativeToolDefinition, requestContextResult } from './mapper.js';
import type { ProtoCodec } from './protobuf.js';

type Dict = Record<string, unknown>;

export interface ExecResponseContext {
  readonly codec: ProtoCodec;
  readonly request: ChatCompletionRequest;
  readonly writeMessage: (message: Dict, compressed?: boolean) => void;
  readonly finish: (error: unknown) => void;
  readonly completeTool: (value: Dict) => boolean;
  readonly holdMcp?: (held: HeldToolExec) => void;
}

export interface HeldToolExec {
  readonly exec: Dict;
  readonly promotedBuiltin?: PromotedBuiltinExecContext;
}

interface ExecReply {
  readonly exec: Dict;
  readonly messageCase: string;
  readonly value: Dict;
  readonly compressed?: boolean;
  readonly localExecutionTimeMs?: number;
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
    id: reply.exec.id,
    message: { case: reply.messageCase, value: reply.value },
    localExecutionTimeMs: reply.localExecutionTimeMs,
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
}

function allowedMcpToolName(request: ChatCompletionRequest, value: Dict): boolean {
  const name = value.toolName ?? value.name;
  if (typeof name !== 'string' || name.length === 0) return false;
  return (request.tools ?? []).some((tool) => tool.function.name === name);
}

export function sendMcpToolResult(
  writeMessage: (message: Dict, compressed?: boolean) => void,
  exec: Dict,
  text: string,
  omitExecId = true,
): void {
  sendExec(writeMessage, {
    exec,
    messageCase: 'mcpResult',
    value: {
      result: {
        case: 'success',
        value: {
          content: [{ content: { case: 'text', value: { text } } }],
          isError: false,
        },
      },
    },
    omitExecId,
    compressed: false,
  });
}

export function sendHeldToolResult(
  writeMessage: (message: Dict, compressed?: boolean) => void,
  held: HeldToolExec,
  text: string,
): void {
  if (!held.promotedBuiltin) {
    sendMcpToolResult(writeMessage, held.exec, text);
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
  const message = dict(exec.message);
  const execCase = typeof message?.case === 'string' ? message.case : undefined;
  const value = dict(message?.value) ?? {};
  if (!execCase) return;
  if (execCase === 'requestContextArgs') {
    sendExec(context.writeMessage, {
      exec,
      messageCase: 'requestContextResult',
      value: requestContextResult(context.request),
      compressed: true,
      localExecutionTimeMs: 1,
    });
    return;
  }
  if (execCase === 'mcpArgs') {
    const name = value.toolName ?? value.name;
    if (typeof name !== 'string' || name.length === 0) {
      // Fail fast instead of leaving the server waiting on an unanswered
      // exec until the run timeout burns the full window.
      sendExec(context.writeMessage, {
        exec,
        messageCase: 'mcpResult',
        value: {
          result: { case: 'error', value: { error: 'Malformed mcpArgs: missing tool name' } },
        },
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
        omitExecId: true,
        compressed: false,
      });
      return 'ignored';
    }
    context.holdMcp?.({ exec });
    return 'held';
  }
  if (execCase === 'mcpAllowlistPrecheckArgs') {
    sendExec(context.writeMessage, {
      exec,
      messageCase: 'mcpAllowlistPrecheckResult',
      value: { allowlisted: true },
    });
    return;
  }
  if (execCase === 'mcpStateExecArgs') {
    const advertised = context.request.tool_choice === 'none' ? [] : (context.request.tools ?? []);
    sendExec(context.writeMessage, {
      exec,
      messageCase: 'mcpStateExecResult',
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
    });
    return;
  }
  const promoted = promoteBuiltinExec(context.request, exec, execCase, value);
  if (promoted) {
    logBuiltinToolRouting(promoted.debug);
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
    if (!context.completeTool(promoted.tool)) {
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
