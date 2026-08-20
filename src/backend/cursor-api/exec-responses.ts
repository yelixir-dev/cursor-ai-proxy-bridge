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
}

interface ExecReply {
  readonly exec: Dict;
  readonly messageCase: string;
  readonly value: Dict;
  readonly compressed?: boolean;
  readonly localExecutionTimeMs?: number;
}

function dict(value: unknown): Dict | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function sendExec(context: ExecResponseContext, reply: ExecReply): void {
  context.writeMessage(
    {
      message: {
        case: 'execClientMessage',
        value: {
          id: reply.exec.id,
          execId: reply.exec.execId,
          message: { case: reply.messageCase, value: reply.value },
          localExecutionTimeMs: reply.localExecutionTimeMs,
        },
      },
    },
    reply.compressed ?? false,
  );
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

export function handleExecResponse(context: ExecResponseContext, exec: Dict): void {
  const message = dict(exec.message);
  const execCase = typeof message?.case === 'string' ? message.case : undefined;
  const value = dict(message?.value) ?? {};
  if (!execCase) return;
  if (execCase === 'requestContextArgs') {
    sendExec(context, {
      exec,
      messageCase: 'requestContextResult',
      value: requestContextResult(context.request),
      compressed: true,
      localExecutionTimeMs: 1,
    });
    return;
  }
  if (execCase === 'mcpArgs') {
    context.completeTool(value);
    return;
  }
  if (execCase === 'mcpAllowlistPrecheckArgs') {
    sendExec(context, {
      exec,
      messageCase: 'mcpAllowlistPrecheckResult',
      value: { allowlisted: true },
    });
    return;
  }
  if (execCase === 'mcpStateExecArgs') {
    sendExec(context, {
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
    sendExec(context, {
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
  sendExec(context, { exec, messageCase: resultCase, value: rejection });
}
