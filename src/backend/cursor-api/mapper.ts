import { randomUUID } from 'node:crypto';
import { homedir, platform, release } from 'node:os';
import { basename, join } from 'node:path';
import type { ChatCompletionRequest, Tool, ToolCall } from '../types.js';
import { buildCursorHistory, type CursorHistory } from './history.js';
import { jsonToProtoValue, loadProtoDescriptors, ProtoCodec } from './protobuf.js';
import { fallbackRequestedModel, type RequestedModelMap } from './requested-models.js';

export { mapRequestedModels, mapUsableModels } from './requested-models.js';
export type { RequestedModelMap } from './requested-models.js';

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
] as const;

export function runRequestMessage(
  request: ChatCompletionRequest,
  requestId: string,
  requestedModels: RequestedModelMap = new Map(),
  history: CursorHistory = buildCursorHistory(request, new ProtoCodec(loadProtoDescriptors())),
): Record<string, unknown> {
  const conversationId = randomUUID();
  const requestedModel =
    requestedModels.get(request.model) ?? fallbackRequestedModel(request.model);
  return {
    message: {
      case: 'runRequest',
      value: {
        conversationState: history.conversationState,
        action: history.action,
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
