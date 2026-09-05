import { once } from 'node:events';
import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { loadNativeAccountContext } from '../src/backend/cursor-api/native-context.js';
import { loadProtoDescriptors, ProtoCodec } from '../src/backend/cursor-api/protobuf.js';

// The provider consumes actual protobuf service responses, not hand-built context objects.
describe('native context selected-token HTTP integration API', () => {
  it('leaves CLI headers with the selected RPC transport and returns virtual managed bytes', async () => {
    const codec = new ProtoCodec(loadProtoDescriptors());
    const seen: {
      method: string;
      clientType: string | string[] | undefined;
      version: string | string[] | undefined;
      request: Record<string, unknown>;
    }[] = [];
    const managedBody = '---\ndescription: Synthetic HTTP skill\n---\nHTTP_SKILL_BODY';
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const method = request.url?.split('/').at(-1) ?? '';
      seen.push({
        method,
        clientType: request.headers['x-cursor-client-type'],
        version: request.headers['x-cursor-client-version'],
        request: codec.decode('aiserver.v1.' + method + 'Request', Buffer.concat(chunks)),
      });
      const data =
        method === 'GetMe'
          ? { authId: 'auth|http-fixture' }
          : method === 'GetManagedSkills'
            ? {
                skills: [
                  {
                    id: 'http-skill',
                    enabled: true,
                    description: 'Synthetic HTTP skill',
                    content: managedBody,
                  },
                ],
              }
            : method === 'GetServerConfig'
              ? {
                  indexingConfig: {
                    defaultUserPathEncryptionKey: Buffer.alloc(32, 1).toString('base64url'),
                  },
                }
              : {};
      response.writeHead(200, { 'content-type': 'application/proto' });
      response.end(codec.encode('aiserver.v1.' + method + 'Response', data));
    });
    const listening = once(server, 'listening');
    server.listen(0, '127.0.0.1');
    await listening;
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing fixture address');
      const origin = 'http://127.0.0.1:' + address.port;
      const signal = AbortSignal.timeout(5_000);
      const account = await loadNativeAccountContext({
        codec,
        signal,
        rpc: async (path, body, signal) => {
          const response = await fetch(origin + path, {
            method: 'POST',
            body: Buffer.from(body),
            signal,
            headers: {
              'content-type': 'application/proto',
              'x-cursor-client-type': 'cli',
              'x-cursor-client-version': codec.descriptors.clientVersion,
            },
          });
          if (!response.ok) throw new Error('Fixture RPC failed');
          return new Uint8Array(await response.arrayBuffer());
        },
        fetch: async () => {
          throw new Error('No plugins advertised: unexpected source request');
        },
      });
      expect(seen.map((item) => item.method).sort()).toEqual([
        'GetEffectiveUserPlugins',
        'GetManagedSkills',
        'GetMe',
        'GetServerConfig',
      ]);
      expect(
        seen.every(
          (item) => item.clientType === 'cli' && item.version === codec.descriptors.clientVersion,
        ),
      ).toBe(true);
      expect(seen.find((item) => item.method === 'GetEffectiveUserPlugins')?.request).toEqual({
        excludeConfiguredVariables: true,
      });
      const context = account.forConversation({
        homeDir: '/virtual/home',
        dataDir: '/virtual/data',
        workspacePath: '/empty',
        conversationId: 'http-conversation',
      });
      expect(
        await context.readFile('/virtual/home/.cursor/skills-cursor/http-skill/SKILL.md'),
      ).toBe(managedBody);
      expect(context.context.agentSkills).toHaveLength(1);
      expect(
        codec.decode(
          'agent.v1.RequestContext',
          codec.encode('agent.v1.RequestContext', { ...context.context }),
        ).hooksConfig,
      ).toEqual({});
      expect(
        codec.decode(
          'agent.v1.McpStateExecArgs',
          codec.encode('agent.v1.McpStateExecArgs', {
            serverIdentifiers: ['virtual'],
            kickOnly: true,
          }),
        ),
      ).toEqual({ serverIdentifiers: ['virtual'], kickOnly: true });
    } finally {
      const closed = once(server, 'close');
      server.close();
      server.closeAllConnections();
      await closed;
    }
  });
});
