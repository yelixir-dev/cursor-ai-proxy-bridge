import type {
  BackendHealth,
  BridgeModel,
  ChatCompletionRequest,
  CompletionResult,
  CursorBackend,
} from './types.js';

const created = 1_700_000_000;

export function defaultCursorModels(): BridgeModel[] {
  return [
    { id: 'cursor-fast', object: 'model', created, owned_by: 'cursor' },
    { id: 'cursor-small', object: 'model', created, owned_by: 'cursor' },
    { id: 'cursor-premium', object: 'model', created, owned_by: 'cursor' },
    { id: 'auto', object: 'model', created, owned_by: 'cursor' },
  ];
}

export function createMockBackend(): CursorBackend {
  return {
    type: 'mock',
    async health(): Promise<BackendHealth> {
      return { ok: true, type: 'mock', authConfigured: true, detail: 'test mock backend' };
    },
    async listModels(): Promise<BridgeModel[]> {
      return defaultCursorModels();
    },
    async complete(request: ChatCompletionRequest): Promise<CompletionResult> {
      const last = request.messages.at(-1)?.content ?? '';
      const content = `mock cursor response: ${last}`;
      const promptTokens = request.messages.reduce((sum, msg) => sum + msg.content.length, 0);
      return {
        content,
        model: request.model,
        usage: {
          prompt_tokens: Math.ceil(promptTokens / 4),
          completion_tokens: Math.ceil(content.length / 4),
          total_tokens: Math.ceil((promptTokens + content.length) / 4),
        },
      };
    },
  };
}
