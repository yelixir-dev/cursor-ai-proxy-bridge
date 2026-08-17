import { randomBytes, randomUUID } from 'node:crypto';
import http2, { type ClientHttp2Stream } from 'node:http2';
import https from 'node:https';
import { gunzipSync } from 'node:zlib';
import type { CursorAuthProvider } from './auth.js';

export interface CursorRunStream {
  readonly destroyed: boolean;
  readonly writableEnded: boolean;
  write(chunk: Uint8Array): boolean;
  destroy(error?: Error): void;
  close(): void;
  on(event: string, listener: (...args: any[]) => void): this;
  once(event: string, listener: (...args: any[]) => void): this;
}

export interface CursorApiTransport {
  unary(
    path: string,
    body: Uint8Array,
    signal?: AbortSignal,
    bootstrapHeaders?: boolean,
    accessToken?: string,
  ): Promise<Buffer>;
  telemetry?(
    path: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
    accessToken?: string,
  ): Promise<void>;
  openRun(baseUrl: string, requestId: string, accessToken?: string): Promise<CursorRunStream>;
}

export interface NodeCursorApiTransportOptions {
  auth: CursorAuthProvider;
  clientVersion: string;
  apiEndpoint?: string;
  agentEndpoint?: string;
  fetch?: typeof globalThis.fetch;
  connect?: typeof http2.connect;
}

export const CURSOR_BOOTSTRAP_UNARY_HEADER_NAMES = [
  'accept-encoding',
  'authorization',
  'connect-protocol-version',
  'content-type',
  'user-agent',
] as const;

export const CURSOR_UNARY_HEADER_NAMES = [
  'accept-encoding',
  'authorization',
  'connect-protocol-version',
  'content-type',
  'user-agent',
  'x-cursor-client-type',
  'x-cursor-client-version',
  'x-ghost-mode',
  'x-request-id',
] as const;

export const CURSOR_RUN_HEADER_NAMES = [
  'authorization',
  'backend-traceparent',
  'connect-accept-encoding',
  'connect-content-encoding',
  'connect-protocol-version',
  'content-type',
  'traceparent',
  'user-agent',
  'x-blob-encryption-key',
  'x-cursor-client-type',
  'x-cursor-client-version',
  'x-ghost-mode',
  'x-original-request-id',
  'x-request-id',
] as const;

export class CursorApiHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'CursorApiHttpError';
  }
}

export class NodeCursorApiTransport implements CursorApiTransport {
  private readonly endpoint: string;
  private readonly agentEndpoint?: string;
  private readonly fetchImplementation?: typeof globalThis.fetch;
  private readonly connectImplementation: typeof http2.connect;

  constructor(private readonly options: NodeCursorApiTransportOptions) {
    this.endpoint = (
      options.apiEndpoint ??
      process.env.CURSOR_BRIDGE_CURSOR_API_ENDPOINT ??
      process.env.CURSOR_API_ENDPOINT ??
      'https://api2.cursor.sh'
    ).replace(/\/$/, '');
    this.agentEndpoint = (
      options.agentEndpoint ?? process.env.CURSOR_BRIDGE_CURSOR_AGENT_ENDPOINT
    )?.replace(/\/$/, '');
    this.fetchImplementation = options.fetch;
    this.connectImplementation = options.connect ?? http2.connect;
  }

  private async headers(
    requestId: string = randomUUID(),
    bootstrapHeaders = false,
    accessToken?: string,
  ): Promise<Record<string, string>> {
    const common = {
      authorization: `Bearer ${accessToken ?? (await this.options.auth.getToken())}`,
      'user-agent': 'connect-es/1.6.1',
    };
    if (bootstrapHeaders) return common;
    return {
      ...common,
      'x-cursor-client-type': 'cli',
      'x-cursor-client-version': this.options.clientVersion,
      'x-ghost-mode': 'true',
      'x-request-id': requestId,
    };
  }

  async unary(
    path: string,
    body: Uint8Array,
    signal?: AbortSignal,
    bootstrapHeaders = false,
    accessToken?: string,
  ): Promise<Buffer> {
    const headers = {
      ...(await this.headers(randomUUID(), bootstrapHeaders, accessToken)),
      'accept-encoding': 'gzip,br',
      'content-type': 'application/proto',
      'connect-protocol-version': '1',
    };
    if (this.fetchImplementation) {
      const response = await this.fetchImplementation(`${this.endpoint}${path}`, {
        method: 'POST',
        headers,
        body: Buffer.from(body),
        signal,
      });
      const payload = Buffer.from(await response.arrayBuffer());
      if (!response.ok) this.throwHttpError(response.status, payload);
      return payload;
    }
    return new Promise<Buffer>((resolve, reject) => {
      const request = https.request(
        `${this.endpoint}${path}`,
        {
          method: 'POST',
          headers:
            body.byteLength === 0
              ? { ...headers, 'content-length': '0' }
              : { ...headers, 'transfer-encoding': 'chunked' },
          signal,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.once('error', reject);
          response.once('end', () => {
            try {
              const wirePayload = Buffer.concat(chunks);
              const payload =
                response.headers['content-encoding'] === 'gzip'
                  ? gunzipSync(wirePayload)
                  : wirePayload;
              const status = response.statusCode ?? 0;
              if (status < 200 || status >= 300) this.throwHttpError(status, payload);
              resolve(payload);
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      request.once('error', reject);
      request.end(Buffer.from(body));
    });
  }

  private throwHttpError(status: number, _payload: Buffer): never {
    throw new CursorApiHttpError(status, `Cursor API request failed with HTTP ${status}`);
  }

  async telemetry(
    path: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
    accessToken?: string,
  ): Promise<void> {
    const traceId = randomBytes(16).toString('hex');
    const response = await (this.fetchImplementation ?? globalThis.fetch)(
      `${this.endpoint}${path}`,
      {
        method: 'POST',
        headers: {
          ...(await this.headers(randomUUID(), false, accessToken)),
          accept: '*/*',
          'accept-language': '*',
          'accept-encoding': 'br, gzip, deflate',
          baggage: `sentry-environment=production,sentry-release=agent-cli%40${this.options.clientVersion.replace(/^cli-/, '')},sentry-public_key=8c7b8823ebc2b8b68c0de054f7d4f6a8,sentry-trace_id=${traceId}`,
          'content-type': 'application/json',
          'sec-fetch-mode': 'cors',
          'sentry-trace': `${traceId}-${randomBytes(8).toString('hex')}`,
          'user-agent': 'node',
        },
        body: JSON.stringify(body),
        signal,
      },
    );
    if (!response.ok) {
      throw new CursorApiHttpError(
        response.status,
        `Cursor telemetry request failed with HTTP ${response.status}`,
      );
    }
  }

  async openRun(
    baseUrl: string,
    requestId: string,
    accessToken?: string,
  ): Promise<CursorRunStream> {
    const session = this.connectImplementation(this.agentEndpoint ?? baseUrl);
    const traceId = randomBytes(16).toString('hex');
    const spanId = randomBytes(8).toString('hex');
    const traceparent = `00-${traceId}-${spanId}-01`;
    const stream: ClientHttp2Stream = session.request({
      ':method': 'POST',
      ':path': '/agent.v1.AgentService/Run',
      ...(await this.headers(requestId, false, accessToken)),
      'backend-traceparent': traceparent,
      'connect-accept-encoding': 'gzip,br',
      'connect-content-encoding': 'gzip',
      'connect-protocol-version': '1',
      'content-type': 'application/connect+proto',
      traceparent,
      'x-blob-encryption-key': randomBytes(32).toString('hex'),
      'x-original-request-id': requestId,
    });
    const closeSession = () => {
      if (!session.closed && !session.destroyed) session.close();
    };
    stream.once('close', closeSession);
    session.once('error', (error) => stream.destroy(error));
    return stream;
  }
}
