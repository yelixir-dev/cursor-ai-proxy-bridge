import { debuglog } from 'node:util';
import { CursorBackendError } from '../cursor-cli.js';
import { allowedToolsForRequest } from '../tool-call-policy.js';
import type { ChatCompletionRequest, Tool } from '../types.js';
import { jsonToProtoValue } from './protobuf.js';
import { rawCursorApiToolName } from './tool-wire-names.js';

type Dict = Record<string, unknown>;

const debug = debuglog('cursor-bridge');
const builtinNames = new Map<string, readonly string[]>([
  ['readArgs', ['read']],
  ['redactedReadArgs', ['read']],
  ['shellArgs', ['shell', 'bash']],
  ['shellStreamArgs', ['shell', 'bash']],
  ['backgroundShellSpawnArgs', ['shell', 'bash']],
  ['forceBackgroundShellArgs', ['shell', 'bash']],
  ['miniSweAgentBashArgs', ['shell', 'bash']],
  ['grepArgs', ['grep']],
  ['lsArgs', ['ls']],
  ['writeArgs', ['write']],
  ['deleteArgs', ['delete']],
  ['fetchArgs', ['fetch']],
]);
const builtinStartCases = new Map<string, string>([
  ['readToolCall', 'readArgs'],
  ['shellToolCall', 'shellArgs'],
  ['grepToolCall', 'grepArgs'],
  ['lsToolCall', 'lsArgs'],
]);
const argumentAliases = new Map<string, readonly string[]>([
  ['path', ['path', 'file_path']],
  ['fileText', ['fileText', 'file_text', 'content', 'text']],
  ['workingDirectory', ['workingDirectory', 'working_directory', 'cwd']],
]);

export class CursorBuiltinToolCallError extends CursorBackendError {
  readonly name = 'CursorBuiltinToolCallError';
  readonly code = 'ERR_CURSOR_BUILTIN_TOOL_CALL';
}

export interface BuiltinToolRoutingDebug {
  readonly execCase: string;
  readonly attemptedToolName: string;
  readonly declaredToolNames: readonly string[];
  readonly mappedOpenAiToolName?: string;
  readonly requested_model: string;
  readonly reasoning_effort: string;
  readonly tool_choice: string;
}

export interface BuiltinToolRoutingLogContext {
  readonly runRequestId?: string;
  readonly toolCallIndex?: number;
  readonly disposition: 'declared' | 'promoted' | 'rejected_undeclared';
}

export interface PromotedBuiltinExec {
  readonly tool: Dict;
  readonly debug: BuiltinToolRoutingDebug;
}

function displayName(name: string): string {
  return rawCursorApiToolName(name);
}

function declaredMatch(
  request: ChatCompletionRequest,
  aliases: readonly string[],
): Tool | undefined {
  const allowed = new Set(aliases.map((name) => name.toLowerCase()));
  return allowedToolsForRequest(request).find((tool) =>
    allowed.has(displayName(tool.function.name).toLowerCase()),
  );
}

function schemaProperties(tool: Tool): ReadonlySet<string> {
  const properties = tool.function.parameters?.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return new Set();
  return new Set(Object.keys(properties));
}

function mappedArguments(tool: Tool, source: Dict): Dict {
  const properties = schemaProperties(tool);
  const mapped: Dict = {};
  for (const [sourceName, value] of Object.entries(source)) {
    if (sourceName === 'toolCallId' || value === undefined) continue;
    const candidates = argumentAliases.get(sourceName) ?? [sourceName];
    const target = candidates.find((name) => properties.has(name));
    if (target) mapped[target] = value;
  }
  if (Object.keys(mapped).length > 0) return mapped;
  return Object.fromEntries(
    Object.entries(source).filter(([name, value]) => name !== 'toolCallId' && value !== undefined),
  );
}

function routingDebug(
  request: ChatCompletionRequest,
  execCase: string,
  aliases: readonly string[],
  mapped?: Tool,
): BuiltinToolRoutingDebug {
  return {
    execCase,
    attemptedToolName: aliases[0] ?? execCase,
    declaredToolNames: (request.tools ?? []).map((tool) => displayName(tool.function.name)),
    ...(mapped === undefined ? {} : { mappedOpenAiToolName: displayName(mapped.function.name) }),
    requested_model: request.model,
    reasoning_effort: request.reasoning_effort ?? 'default',
    tool_choice:
      typeof request.tool_choice === 'object'
        ? `function:${displayName(request.tool_choice.function.name)}`
        : (request.tool_choice ?? (request.tools?.length ? 'auto' : 'none')),
  };
}

export function builtinToolRoutingLog(
  fields: BuiltinToolRoutingDebug,
  context: BuiltinToolRoutingLogContext,
): Record<string, unknown> {
  return {
    requested_model: fields.requested_model,
    reasoning_effort: fields.reasoning_effort,
    tool_choice: fields.tool_choice,
    declared_tool_names: fields.declaredToolNames,
    attempted_builtin_name: fields.attemptedToolName,
    promoted_external_tool_name: fields.mappedOpenAiToolName ?? null,
    tool_call_index: context.toolCallIndex ?? null,
    run_request_id: context.runRequestId ?? 'unknown',
    call_origin: 'model_generated_builtin',
    disposition: context.disposition,
  };
}

export function logBuiltinToolRouting(
  fields: BuiltinToolRoutingDebug,
  context: BuiltinToolRoutingLogContext,
): void {
  debug('builtin exec routing %o', builtinToolRoutingLog(fields, context));
}

export function builtinStartRouting(
  request: ChatCompletionRequest,
  update: Dict,
): BuiltinToolRoutingDebug | undefined {
  const toolCall = dict(update.toolCall);
  const tool = dict(toolCall?.tool);
  const execCase = typeof tool?.case === 'string' ? builtinStartCases.get(tool.case) : undefined;
  if (!execCase) return undefined;
  const aliases = builtinNames.get(execCase);
  if (!aliases) return undefined;
  return routingDebug(request, execCase, aliases, declaredMatch(request, aliases));
}

export function promoteBuiltinExec(
  request: ChatCompletionRequest,
  exec: Dict,
  execCase: string,
  value: Dict,
): PromotedBuiltinExec | undefined {
  const aliases = builtinNames.get(execCase);
  if (!aliases) return undefined;
  const mapped = declaredMatch(request, aliases);
  const fields = routingDebug(request, execCase, aliases, mapped);
  if (!mapped) return { tool: {}, debug: fields };
  const id = String(value.toolCallId ?? exec.execId ?? exec.id ?? '');
  const args = Object.fromEntries(
    Object.entries(mappedArguments(mapped, value)).map(([name, argument]) => [
      name,
      jsonToProtoValue(argument),
    ]),
  );
  return {
    debug: fields,
    tool: {
      name: mapped.function.name,
      toolName: mapped.function.name,
      toolCallId: id,
      providerIdentifier: 'bridge',
      args,
    },
  };
}

function dict(value: unknown): Dict | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}
