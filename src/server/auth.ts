import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { BridgeConfig } from '../config.js';

export class ServerConfigurationError extends Error {
  readonly name = 'ServerConfigurationError';
}

export function normalizedConfig(source: BridgeConfig): BridgeConfig {
  const apiKey = source.apiKey?.trim();
  if (source.apiKey !== undefined && !apiKey) {
    throw new ServerConfigurationError('CURSOR_BRIDGE_API_KEY must not be empty or whitespace');
  }
  const clientAuth = source.clientAuth ?? (apiKey ? 'on' : 'off');
  if (clientAuth === 'on' && !apiKey) {
    throw new ServerConfigurationError('CURSOR_BRIDGE_AUTH=on requires CURSOR_BRIDGE_API_KEY');
  }
  return { ...source, apiKey, clientAuth };
}

export function tokenFromRequest(request: FastifyRequest): string | undefined {
  const authorization = request.headers.authorization;
  if (authorization?.toLowerCase().startsWith('bearer ')) {
    return authorization.slice(7).trim();
  }
  const apiKey = request.headers['x-api-key'];
  return Array.isArray(apiKey) ? apiKey[0] : apiKey;
}

export function timingSafeKeyEqual(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left).digest();
  const rightDigest = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

export async function requireClientAuth(
  request: FastifyRequest,
  reply: FastifyReply,
  config: BridgeConfig,
): Promise<boolean> {
  if (config.clientAuth === 'off') return true;
  const apiKey = config.apiKey;
  if (!apiKey) {
    throw new ServerConfigurationError('CURSOR_BRIDGE_AUTH=on requires CURSOR_BRIDGE_API_KEY');
  }
  const token = tokenFromRequest(request);
  if (token !== undefined && timingSafeKeyEqual(token, apiKey)) return true;
  await reply.code(401).send({
    error: {
      type: 'authentication_error',
      message: 'Missing or invalid Cursor Bridge client API key',
    },
  });
  return false;
}
