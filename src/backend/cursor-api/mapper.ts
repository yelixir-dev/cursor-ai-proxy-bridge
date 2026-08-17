import { randomUUID } from 'node:crypto';
import { homedir, platform, release } from 'node:os';
import { basename, join } from 'node:path';
import type {
  BridgeModel,
  ChatCompletionRequest,
  CompletionUsage,
  Tool,
  ToolCall,
} from '../types.js';
import { promptFromMessages } from '../cursor-cli.js';
import { protoValueToJson, jsonToProtoValue } from './protobuf.js';

const MODEL_CREATED = 1_700_000_000;

type RequestedModel = {
  modelId: string;
  maxMode: boolean;
  parameters: Array<{ id: string; value: string }>;
  builtInModel: boolean;
  isVariantStringRepresentation: boolean;
};

export type RequestedModelMap = ReadonlyMap<string, RequestedModel>;

const SELECTED_SUBAGENT_MODELS = [
  { modelId: 'default' },
  {
    modelId: 'grok-4.6',
    parameters: [
      { id: 'effort', value: 'high' },
      { id: 'fast', value: 'true' },
    ],
  },
  { modelId: 'composer-2.5', parameters: [{ id: 'fast', value: 'false' }] },
  {
    modelId: 'claude-opus-5',
    parameters: [
      { id: 'thinking', value: 'true' },
      { id: 'context', value: '300k' },
      { id: 'effort', value: 'high' },
      { id: 'fast', value: 'false' },
    ],
  },
  {
    modelId: 'gpt-5.6-sol',
    parameters: [
      { id: 'context', value: '272k' },
      { id: 'reasoning', value: 'medium' },
      { id: 'fast', value: 'false' },
    ],
  },
  {
    modelId: 'claude-fable-5',
    parameters: [
      { id: 'thinking', value: 'true' },
      { id: 'context', value: '300k' },
      { id: 'effort', value: 'high' },
    ],
  },
  {
    modelId: 'grok-4.5',
    parameters: [
      { id: 'effort', value: 'high' },
      { id: 'fast', value: 'true' },
    ],
  },
  { modelId: 'gemini-3.7-flash', parameters: [{ id: 'effort', value: 'high' }] },
  {
    modelId: 'gpt-5.6-terra',
    parameters: [
      { id: 'context', value: '272k' },
      { id: 'reasoning', value: 'medium' },
      { id: 'fast', value: 'false' },
    ],
  },
  {
    modelId: 'claude-sonnet-5',
    parameters: [
      { id: 'thinking', value: 'true' },
      { id: 'context', value: '300k' },
      { id: 'effort', value: 'high' },
    ],
  },
];

function nativeToolInstruction(request: ChatCompletionRequest): string {
  if (!request.tools?.length) return '';
  if (request.tool_choice === 'none') {
    return '\n\nDo not call any available tool. Answer directly in ordinary text.';
  }
  if (typeof request.tool_choice === 'object') {
    return `\n\nYou must call exactly the tool ${JSON.stringify(request.tool_choice.function.name)}. Do not answer directly.`;
  }
  if (request.tool_choice === 'required') {
    return '\n\nYou must call at least one available tool. Do not answer directly.';
  }
  return '\n\nUse an available tool only when it is needed. Do not pretend to execute tools yourself.';
}

export function cursorApiPrompt(request: ChatCompletionRequest): string {
  const flattened = promptFromMessages({
    ...request,
    tools: undefined,
    tool_choice: undefined,
    parallel_tool_calls: undefined,
  });
  const parallel =
    request.tools?.length && request.parallel_tool_calls === false
      ? '\nReturn at most one tool call.'
      : '';
  const toolResultFollowUp =
    request.messages.at(-1)?.role === 'tool' && request.tool_choice !== 'required'
      ? '\nA tool result was just supplied. Do not call a tool again in this turn; answer from that result.'
      : '';
  return flattened + nativeToolInstruction(request) + parallel + toolResultFollowUp;
}

function fallbackRequestedModel(modelId: string): RequestedModel {
  return {
    modelId,
    maxMode: false,
    parameters: [{ id: 'fast', value: 'false' }],
    builtInModel: false,
    isVariantStringRepresentation: false,
  };
}

export function mapRequestedModels(
  availableModels: Record<string, any>,
  usableModels: Record<string, any>,
): Map<string, RequestedModel> {
  const usableMaxMode = new Map<string, boolean>();
  for (const model of usableModels.models ?? []) {
    for (const id of [model.modelId, model.displayModelId, ...(model.aliases ?? [])]) {
      if (typeof id === 'string' && id) usableMaxMode.set(id, Boolean(model.maxMode));
    }
  }

  const requestedModels = new Map<string, RequestedModel>();
  for (const model of availableModels.models ?? []) {
    const modelId = model.name || model.serverModelName;
    if (typeof modelId !== 'string' || !modelId) continue;
    for (const variant of model.variants ?? []) {
      const maxMode = Boolean(variant.isMaxMode);
      const parameters = (variant.parameterValues ?? []).filter(
        (parameter: Record<string, unknown>) =>
          typeof parameter.id === 'string' && typeof parameter.value === 'string',
      );
      const aliases = [
        [variant.legacySlug, false],
        [variant.variantStringRepresentation, true],
      ] as const;
      for (const [alias, isVariantStringRepresentation] of aliases) {
        if (typeof alias !== 'string' || !alias) continue;
        const expectedMaxMode = usableMaxMode.get(alias);
        if (expectedMaxMode !== undefined && expectedMaxMode !== maxMode) continue;
        if (expectedMaxMode === undefined && requestedModels.has(alias) && maxMode) continue;
        requestedModels.set(alias, {
          modelId,
          maxMode,
          parameters,
          builtInModel: false,
          isVariantStringRepresentation,
        });
      }
    }
  }
  return requestedModels;
}

export function runRequestMessage(
  request: ChatCompletionRequest,
  requestId: string,
  requestedModels: RequestedModelMap = new Map(),
): Record<string, unknown> {
  const conversationId = randomUUID();
  const requestedModel =
    requestedModels.get(request.model) ?? fallbackRequestedModel(request.model);
  return {
    message: {
      case: 'runRequest',
      value: {
        conversationState: {},
        action: {
          action: {
            case: 'userMessageAction',
            value: {
              userMessage: {
                text: cursorApiPrompt(request),
                messageId: randomUUID(),
                selectedContext: {},
                mode: request.tools?.length && request.tool_choice !== 'none' ? 2 : 1,
                conversationStateBlobId: Buffer.alloc(0),
              },
            },
          },
        },
        mcpTools: {},
        requestedModel,
        conversationId,
        excludeWorkspaceContext: false,
        selectedSubagentModels: SELECTED_SUBAGENT_MODELS.map((model) =>
          model.modelId === requestedModel.modelId ? requestedModel : model,
        ),
        conversationGroupId: conversationId,
        runId: requestId,
      },
    },
  };
}

export function heartbeatMessage(): Record<string, unknown> {
  return { message: { case: 'clientHeartbeat', value: {} } };
}

export function nativeToolDefinition(tool: Tool): Record<string, unknown> {
  return {
    name: tool.function.name,
    description: tool.function.description ?? '',
    inputSchema: jsonToProtoValue(tool.function.parameters ?? { type: 'object' }),
    providerIdentifier: 'bridge',
    toolName: tool.function.name,
  };
}

export function requestContextResult(
  request: ChatCompletionRequest,
  cwd = process.cwd(),
  environment: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> {
  const projectName = cwd.replace(/^\/+/, '').replace(/[^a-zA-Z0-9]+/g, '-');
  const projectFolder = join(homedir(), '.cursor', 'projects', projectName);
  const conversationId = basename(projectFolder);
  return {
    result: {
      case: 'success',
      value: {
        requestContext: {
          env: {
            osVersion: `${platform()} ${release()}`,
            workspacePaths: [cwd],
            shell: basename(environment.SHELL || '/bin/zsh'),
            terminalsFolder: join(projectFolder, 'terminals'),
            agentSharedNotesFolder: join(projectFolder, 'agent-notes', 'shared'),
            agentConversationNotesFolder: join(projectFolder, 'agent-notes', conversationId),
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            projectFolder,
            agentTranscriptsFolder: join(projectFolder, 'agent-transcripts'),
            sandboxSupported: true,
            sandboxNetworkHasDefaults: true,
            computerUseSupported: false,
            isWorkingDirHomeDir: cwd === homedir(),
            processWorkingDirectory: cwd,
            smartModeClassifierAutoModeEnabled: false,
          },
          tools: (request.tools ?? []).map(nativeToolDefinition),
          supportsMcpAuth: true,
          gitRepoInfoComplete: true,
        },
      },
    },
  };
}

export function mcpArgsToToolCall(args: Record<string, any>): ToolCall {
  const decoded = Object.fromEntries(
    Object.entries(args.args ?? {}).map(([key, value]) => [
      key,
      protoValueToJson(value as Record<string, any>),
    ]),
  );
  const name = String(args.toolName || args.name || 'unknown_tool');
  return {
    id: String(args.toolCallId || `call_bridge_${randomUUID()}`),
    type: 'function',
    function: { name, arguments: JSON.stringify(decoded) },
  };
}

export function enforceNativeToolChoice(
  calls: ToolCall[],
  request: ChatCompletionRequest,
): ToolCall[] {
  if (request.tool_choice === 'none') return [];
  const allowed = new Set((request.tools ?? []).map((tool) => tool.function.name));
  const forced =
    typeof request.tool_choice === 'object' ? request.tool_choice.function.name : undefined;
  const filtered = calls.filter(
    (call) => allowed.has(call.function.name) && (!forced || call.function.name === forced),
  );
  return request.parallel_tool_calls === false ? filtered.slice(0, 1) : filtered;
}

export function nativeToolBatchComplete(
  announcedToolCallIds: ReadonlySet<string>,
  calls: readonly ToolCall[],
  parallelToolCalls: boolean,
): boolean {
  if (!parallelToolCalls) return calls.length > 0;
  if (announcedToolCallIds.size === 0 || calls.length !== announcedToolCallIds.size) return false;
  return calls.every((call) => announcedToolCallIds.has(call.id));
}

function finiteToken(value: unknown): number {
  if (typeof value === 'bigint') return Number(value);
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function usageFromTurnEnded(value: Record<string, unknown>): CompletionUsage {
  const prompt = finiteToken(value.inputTokens);
  const completion = finiteToken(value.outputTokens);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
}

export function mapUsableModels(message: Record<string, any>): BridgeModel[] {
  const ids = new Set<string>();
  for (const model of message.models ?? []) {
    const id = model.modelId || model.displayModelId;
    if (typeof id === 'string' && id) ids.add(id);
    for (const alias of model.aliases ?? []) if (typeof alias === 'string' && alias) ids.add(alias);
  }
  return [...ids].map((id) => ({
    id,
    object: 'model',
    created: MODEL_CREATED,
    owned_by: 'cursor',
  }));
}
