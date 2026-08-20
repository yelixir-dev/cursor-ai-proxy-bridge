import { basename } from 'node:path';
import type { BridgeConfig } from '../config.js';
import type { BridgeModel, ChatCompletionRequest } from './types.js';

export const MODEL_DISCOVERY_TIMEOUT_MS = 10_000;
export const MODEL_CACHE_TTL_MS = 60_000;
const MODEL_CREATED = 1_700_000_000;

export function validCursorTimeoutMs(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 1_000 && parsed <= 600_000 ? parsed : 120_000;
}

export function cursorModelsArgs(cursorBin: string): string[] {
  const binName = basename(cursorBin);
  return binName === 'agent' || binName === 'cursor-agent' ? ['models'] : ['agent', 'models'];
}

export function parseCursorModels(output: string): BridgeModel[] {
  const ids = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const separatorIndex = line.indexOf(' - ');
    if (separatorIndex <= 0) continue;
    const id = line.slice(0, separatorIndex).trim();
    if (id) ids.add(id);
  }
  return [...ids].map(cursorModel);
}

export function cursorModel(id: string): BridgeModel {
  return {
    id,
    object: 'model',
    created: MODEL_CREATED,
    owned_by: 'cursor',
  };
}

export type CursorCliInvocation = {
  readonly cursorBin: string;
  readonly request: ChatCompletionRequest;
  readonly workspacePath: string;
  readonly workspaceMode: BridgeConfig['workspaceMode'];
  readonly streaming?: boolean;
};

export function cursorCliArgs(invocation: CursorCliInvocation): string[] {
  const { cursorBin, request, workspacePath, workspaceMode, streaming = false } = invocation;
  const baseArgs = [
    '--print',
    '--trust',
    ...(workspaceMode === 'chat-only' ? ['--mode', 'ask'] : []),
    '--workspace',
    workspacePath,
    '--model',
    request.model,
    '--output-format',
    streaming ? 'stream-json' : 'json',
    ...(streaming ? ['--stream-partial-output'] : []),
  ];
  const binName = basename(cursorBin);
  return binName === 'agent' || binName === 'cursor-agent' ? baseArgs : ['agent', ...baseArgs];
}
