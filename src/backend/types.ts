export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
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
  content: string;
  model: string;
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
