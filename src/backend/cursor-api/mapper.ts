import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir, platform, release } from 'node:os';
import { delimiter, join } from 'node:path';
import type { ChatCompletionRequest, Tool, ToolCall } from '../types.js';
import { buildCursorHistory, type CursorHistory } from './history.js';
import type { NativeContextPatch } from './native-context.js';
import { jsonToProtoValue, loadProtoDescriptors, ProtoCodec } from './protobuf.js';
import {
  fallbackRequestedModel,
  type RequestedModel,
  type RequestedModelMap,
} from './requested-models.js';

import type { SelectedSubagentModel } from './subagent-models.js';
import { rawCursorApiToolName } from './tool-wire-names.js';

export { mapRequestedModels, mapUsableModels } from './requested-models.js';
export type { RequestedModelMap } from './requested-models.js';

export function runRequestMessage(
  request: ChatCompletionRequest,
  requestId: string,
  requestedModels: RequestedModelMap = new Map(),
  history: CursorHistory = buildCursorHistory(request, new ProtoCodec(loadProtoDescriptors())),
  resolvedModel?: RequestedModel,
  selectedSubagentModels: readonly SelectedSubagentModel[] = [],
) {
  const conversationId = randomUUID();
  const requestedModel =
    resolvedModel ?? requestedModels.get(request.model) ?? fallbackRequestedModel(request.model);
  return {
    message: {
      case: 'runRequest',
      value: {
        conversationState: history.conversationState,
        action: history.action,
        mcpTools: {},
        requestedModel: {
          modelId: requestedModel.modelId,
          parameters: requestedModel.parameters,
          ...(requestedModel.maxMode ? { maxMode: true } : {}),
          ...(requestedModel.builtInModel ? { builtInModel: true } : {}),
          ...(requestedModel.isVariantStringRepresentation
            ? { isVariantStringRepresentation: true }
            : {}),
        },
        conversationId,
        excludeWorkspaceContext: false,
        selectedSubagentModels: selectedSubagentModels.map((model) => ({
          modelId: model.modelId,
          parameters:
            model.modelId === requestedModel.modelId ? requestedModel.parameters : model.parameters,
          ...(requestedModel.maxMode ? { maxMode: true } : {}),
        })),
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
    toolName: rawCursorApiToolName(tool.function.name),
  };
}

export function requestContextResult(
  request: ChatCompletionRequest,
  cwd = process.cwd(),
  environment: NodeJS.ProcessEnv = process.env,
  conversationId: string = randomUUID(),
  nativeContext?: NativeContextPatch,
): Record<string, unknown> {
  const projectName = cwd.replace(/^\/+/, '').replace(/[^a-zA-Z0-9]+/g, '-');
  const home = environment.HOME?.trim() || homedir();
  const dataDirectory = environment.CURSOR_DATA_DIR?.trim() || join(home, '.cursor');
  const projectFolder = join(dataDirectory, 'projects', projectName);
  // Native getSuggestedShell prefers recognized SHELL hints, then its PATH lookup order.
  const shells = ['zsh', 'bash', 'pwsh', 'powershell'];
  const selectedShell =
    shells.find((shell) => environment.SHELL?.includes(shell)) ??
    shells.find((shell) =>
      [cwd, ...(environment.PATH ?? '').split(delimiter)].some((directory) =>
        existsSync(join(directory, shell)),
      ),
    );
  const shell = selectedShell === 'pwsh' ? 'powershell' : (selectedShell ?? 'naive');
  return {
    result: {
      case: 'success',
      value: {
        requestContext: {
          ...nativeContext,
          env: {
            osVersion: `${platform()} ${release()}`,
            workspacePaths: [cwd],
            shell,
            terminalsFolder: join(projectFolder, 'terminals'),
            agentSharedNotesFolder: join(projectFolder, 'agent-notes', 'shared'),
            agentConversationNotesFolder: join(projectFolder, 'agent-notes', conversationId),
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            projectFolder,
            agentTranscriptsFolder: join(projectFolder, 'agent-transcripts'),
            sandboxSupported: true,
            sandboxNetworkHasDefaults: true,
            computerUseSupported: false,
            isWorkingDirHomeDir: cwd === home,
            processWorkingDirectory: cwd,
            smartModeClassifierAutoModeEnabled: false,
            ...nativeContext?.env,
          },
          // Pinned installed-CLI profile: meta is enabled and this account uses slim descriptors.
          // Full schemas are served on demand via mcpStateExec, not RequestContext.tools.
          mcpMetaToolOptions: {
            enabled: true,
            mcpDescriptors:
              request.tool_choice === 'none' || !request.tools?.length
                ? []
                : [
                    {
                      serverName: 'bridge',
                      serverIdentifier: 'bridge',
                      tools: request.tools.map((tool) => ({
                        toolName: rawCursorApiToolName(tool.function.name),
                      })),
                    },
                  ],
          },
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
