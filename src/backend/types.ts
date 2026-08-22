import type {
  CursorApiCredential,
  CursorApiCredentialStateView,
} from './cursor-api/credentials.js';

export type ChatRole = 'system' | 'developer' | 'user' | 'assistant' | 'tool';

export interface ToolFunction {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface Tool {
  type: 'function';
  function: ToolFunction;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export type ToolChoice =
  | 'none'
  | 'auto'
  | 'required'
  | { type: 'function'; function: { name: string } };

export interface ChatMessage {
  role: ChatRole;
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  temperature?: number;
  max_tokens?: number;
  tools?: Tool[];
  tool_choice?: ToolChoice;
  parallel_tool_calls?: boolean;
  reasoning_effort?: string;
}

export interface BridgeModel {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
}

export interface BackendHealth {
  ok: boolean;
  type: string;
  authConfigured: boolean;
  detail?: string;
  configuredMode?: string;
  activeBackend?: string;
  fallbackAvailable?: boolean;
  flipState?: {
    consecutiveFatal: number;
    cooldownUntil?: number;
    reason?: string;
  };
}

export type UsageSource = 'turnEnded' | 'cli_reported' | 'estimated' | 'unknown';

export interface CompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface CompletionResult {
  content: string | null;
  model: string;
  tool_calls?: ToolCall[];
  usage?: CompletionUsage;
  usage_source?: UsageSource;
}

export type CompletionStreamEvent =
  | { readonly type: 'thinking'; readonly text: string }
  | { readonly type: 'content'; readonly text: string }
  | {
      readonly type: 'tool_call_start';
      readonly index: number;
      readonly id: string;
      readonly name: string;
    }
  | {
      readonly type: 'tool_call_arguments_delta';
      readonly index: number;
      readonly id: string;
      readonly delta: string;
    }
  | {
      readonly type: 'tool_call_complete';
      readonly index: number;
      readonly call: ToolCall;
    }
  | {
      readonly type: 'done';
      readonly usage: CompletionUsage;
      readonly usage_source?: UsageSource;
      readonly is_error: boolean;
      readonly message?: string;
    };

export interface CursorBackend {
  readonly type: string;
  health(): Promise<BackendHealth>;
  listModels(): Promise<BridgeModel[]>;
  complete(request: ChatCompletionRequest, signal?: AbortSignal): Promise<CompletionResult>;
  completeStream(
    request: ChatCompletionRequest,
    signal?: AbortSignal,
  ): AsyncIterable<CompletionStreamEvent>;
  shutdown?(): Promise<void>;
  credentialStates?(): CursorApiCredentialStateView[];
  updateCredentials?(credentials: CursorApiCredential[]): void;
}
