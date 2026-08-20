function localBridgeUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', '::1', 'localhost'].includes(url.hostname)) {
    throw new Error('benchmark bridge URL must be a local HTTP endpoint');
  }
  return url.toString().replace(/\/$/, '');
}

export function providerDefinition(bridgeBaseUrl: string): string {
  const definition = {
    providers: {
      yorha: {
        baseUrl: localBridgeUrl(bridgeBaseUrl),
        api: 'openai-completions',
        apiKey: 'benchmark-local-not-a-secret',
        models: [
          {
            id: 'composer-2.5',
            name: 'Composer 2.5',
            upstreamModelId: 'composer-2.5',
            reasoning: false,
            input: ['text'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200_000,
            maxTokens: 64_000,
            compat: { supportsStore: false, supportsDeveloperRole: false },
          },
        ],
      },
    },
  };
  return `${JSON.stringify(definition, null, 2)}\n`;
}
