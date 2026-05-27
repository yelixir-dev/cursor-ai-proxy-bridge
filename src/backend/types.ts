export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

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
  temperature?: number;
  max_tokens?: number;
  tools?: Tool[];
  tool_choice?: ToolChoice;
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
}

export interface CompletionResult {
  content: string | null;
  model: string;
  tool_calls?: ToolCall[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface CursorBackend {
  readonly type: string;
  health(): Promise<BackendHealth>;
  listModels(): Promise<BridgeModel[]>;
  complete(request: ChatCompletionRequest): Promise<CompletionResult>;
}
