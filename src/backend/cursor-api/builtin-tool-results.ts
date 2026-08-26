import type { ProtoCodec } from './protobuf.js';

type Dict = Record<string, unknown>;

export interface PromotedBuiltinExecContext {
  readonly execCase: string;
  readonly args: Dict;
}

export interface BuiltinToolResultReply {
  readonly messageCase: string;
  readonly value: Dict;
}

export function emptyBuiltinResult(codec: ProtoCodec, resultCase: string): Dict | undefined {
  const resultField = codec.descriptors.messages['agent.v1.ExecClientMessage']?.fields.find(
    (field) => field.localName === resultCase,
  );
  if (!resultField?.message) return undefined;
  const failureField = codec.descriptors.messages[resultField.message]?.fields.find((field) =>
    ['rejected', 'error', 'permissionDenied', 'failure'].includes(field.localName),
  );
  if (!failureField?.message) return {};
  const value = Object.fromEntries(
    (codec.descriptors.messages[failureField.message]?.fields ?? [])
      .filter((field) => !field.repeated && field.kind !== 'map')
      .map((field) => {
        if (field.kind === 'message') return [field.localName, {}];
        if (field.scalar === 9) return [field.localName, ''];
        if (field.scalar === 12) return [field.localName, Buffer.alloc(0)];
        if (field.scalar === 8) return [field.localName, false];
        return [field.localName, 0];
      }),
  );
  return failureField.oneof
    ? { [failureField.oneof]: { case: failureField.localName, value } }
    : { [failureField.localName]: value };
}

const resultCases = new Map<string, string>([
  ['readArgs', 'readResult'],
  ['redactedReadArgs', 'readResult'],
  ['shellArgs', 'shellResult'],
  ['shellStreamArgs', 'shellResult'],
  ['backgroundShellSpawnArgs', 'shellResult'],
  ['forceBackgroundShellArgs', 'shellResult'],
  ['miniSweAgentBashArgs', 'shellResult'],
  ['grepArgs', 'grepResult'],
  ['lsArgs', 'lsResult'],
  ['writeArgs', 'writeResult'],
  ['deleteArgs', 'deleteResult'],
  ['fetchArgs', 'fetchResult'],
]);

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function successValue(context: PromotedBuiltinExecContext, result: string): Dict {
  const args = context.args;
  switch (context.execCase) {
    case 'readArgs':
    case 'redactedReadArgs':
      return {
        path: text(args.path),
        output: { case: 'content', value: result },
        totalLines: result ? result.split(/\r?\n/u).length : 0,
        fileSize: Buffer.byteLength(result),
        truncated: false,
        rangeApplied: false,
      };
    case 'shellArgs':
    case 'shellStreamArgs':
    case 'backgroundShellSpawnArgs':
    case 'forceBackgroundShellArgs':
    case 'miniSweAgentBashArgs':
      return {
        command: text(args.command),
        workingDirectory: text(args.workingDirectory),
        exitCode: 0,
        stdout: result,
        stderr: '',
        interleavedOutput: result,
      };
    case 'grepArgs': {
      const path = text(args.path);
      return {
        pattern: text(args.pattern),
        path,
        outputMode: text(args.outputMode) || 'content',
        activeEditorResult: {
          result: {
            case: 'content',
            value: {
              matches: [
                {
                  file: path,
                  matches: [
                    {
                      lineNumber: 1,
                      content: result,
                      contentTruncated: false,
                      isContextLine: false,
                    },
                  ],
                },
              ],
              totalLines: 1,
              totalMatchedLines: 1,
            },
          },
        },
      };
    }
    case 'lsArgs':
      return {
        directoryTreeRoot: {
          absPath: text(args.path),
          childrenFiles: [{ name: result }],
          childrenWereProcessed: true,
          numFiles: result ? 1 : 0,
        },
      };
    case 'writeArgs':
      return { path: text(args.path), fileContentAfterWrite: result };
    case 'deleteArgs':
      return { path: text(args.path), deletedFile: text(args.path), prevContent: result };
    case 'fetchArgs':
      return { url: text(args.url), content: result, statusCode: 200 };
    default:
      return {};
  }
}

export function builtinToolResultReply(
  context: PromotedBuiltinExecContext,
  result: string,
): BuiltinToolResultReply | undefined {
  const messageCase = resultCases.get(context.execCase);
  if (!messageCase) return undefined;
  return {
    messageCase,
    value: { result: { case: 'success', value: successValue(context, result) } },
  };
}
