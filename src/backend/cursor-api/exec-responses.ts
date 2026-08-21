import type { ChatCompletionRequest } from '../types.js';
import { CursorBackendError } from '../cursor-cli.js';
import { nativeToolDefinition, requestContextResult } from './mapper.js';
import type { ProtoCodec } from './protobuf.js';

type Dict = Record<string, unknown>;

export interface ExecResponseContext {
  readonly codec: ProtoCodec;
  readonly request: ChatCompletionRequest;
  readonly writeMessage: (message: Dict, compressed?: boolean) => void;
  readonly finish: (error: unknown) => void;
  readonly completeTool: (value: Dict) => void;
  readonly holdMcp?: (exec: Dict) => void;
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

function rejectionValue(
  context: ExecResponseContext,
  resultCase: string,
  args: Dict,
): Dict | undefined {
  const resultField = context.codec.descriptors.messages['agent.v1.ExecClientMessage']?.fields.find(
    (field) => field.localName === resultCase,
  );
  if (!resultField?.message) return undefined;
  const resultDescriptor = context.codec.descriptors.messages[resultField.message];
  const failureField = resultDescriptor?.fields.find((field) =>
    ['rejected', 'error', 'permissionDenied', 'failure'].includes(field.localName),
  );
  if (!failureField?.message) return {};
  const rejectionMessage = 'Tool execution is delegated to the OpenAI client';
  const failureValue = Object.fromEntries(
    (context.codec.descriptors.messages[failureField.message]?.fields ?? [])
      .filter((field) => !field.repeated && field.kind !== 'map')
      .map((field) => {
        if (field.kind === 'message') return [field.localName, {}];
        if (field.scalar === 9) {
          const fromArgs = args[field.localName];
          return [
            field.localName,
            typeof fromArgs === 'string'
              ? fromArgs
              : ['reason', 'error'].includes(field.localName)
                ? rejectionMessage
                : '',
          ];
        }
        if (field.scalar === 12) return [field.localName, Buffer.alloc(0)];
        if (field.scalar === 8) return [field.localName, false];
        return [field.localName, 0];
      }),
  );
  return failureField.oneof
    ? { [failureField.oneof]: { case: failureField.localName, value: failureValue } }
    : { [failureField.localName]: failureValue };
}

export function sendMcpToolResult(
  writeMessage: (message: Dict, compressed?: boolean) => void,
  exec: Dict,
  text: string,
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
    omitExecId: true,
    compressed: false,
  });
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
    context.completeTool(value);
    context.holdMcp?.(exec);
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
    sendExec(context.writeMessage, {
      exec,
      messageCase: 'mcpStateExecResult',
      value: {
        result: {
          case: 'success',
          value: {
            servers: [
              {
                serverName: 'bridge',
                serverIdentifier: 'bridge',
                tools: (context.request.tools ?? []).map(nativeToolDefinition),
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
  const resultCase =
    execCase === 'shellStreamArgs'
      ? 'shellResult'
      : execCase.replace(/Args$/, 'Result').replace(/Request$/, 'Response');
  const rejection = rejectionValue(context, resultCase, value);
  if (!rejection) {
    context.finish(new CursorBackendError(`Cannot answer Cursor exec message ${execCase}`));
    return;
  }
  sendExec(context.writeMessage, { exec, messageCase: resultCase, value: rejection });
}
