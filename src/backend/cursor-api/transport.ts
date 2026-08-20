import { randomBytes, randomUUID } from 'node:crypto';
import http2 from 'node:http2';
import { traceRunOpen, traceStage, type RequestTrace } from '../../trace.js';
import type { CursorAuthProvider } from './auth.js';
import { fingerprintCredential, H2SessionPool, type H2Connector } from './h2-session-pool.js';
import {
  DEFAULT_MAX_UNARY_COMPRESSED_BYTES,
  DEFAULT_MAX_UNARY_DECOMPRESSED_BYTES,
} from './unary-body.js';
import { sendUnaryRequest } from './unary-transport.js';

export {
  CURSOR_BOOTSTRAP_UNARY_HEADER_NAMES,
  CURSOR_RUN_HEADER_NAMES,
  CURSOR_UNARY_HEADER_NAMES,
} from './transport-headers.js';

interface CursorRunStreamEvents {
  readonly response: [headers: Record<string, unknown>];
  readonly data: [chunk: Buffer];
  readonly error: [error: Error];
  readonly close: [];
}

export interface CursorRunStream {
  readonly destroyed: boolean;
  readonly writableEnded: boolean;
  write(chunk: Uint8Array): boolean;
  destroy(error?: Error): void;
  close(): void;
  on<Event extends keyof CursorRunStreamEvents>(
    event: Event,
    listener: (...args: CursorRunStreamEvents[Event]) => void,
  ): this;
  once<Event extends keyof CursorRunStreamEvents>(
    event: Event,
    listener: (...args: CursorRunStreamEvents[Event]) => void,
  ): this;
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
  openRun(
    baseUrl: string,
    requestId: string,
    accessToken?: string,
    trace?: RequestTrace,
  ): Promise<CursorRunStream>;
  shutdown?(): Promise<void>;
}

export interface NodeCursorApiTransportOptions {
  auth: CursorAuthProvider;
  clientVersion: string;
  apiEndpoint?: string;
  agentEndpoint?: string;
  fetch?: typeof globalThis.fetch;
  connect?: H2Connector;
  maxSessionPoolEntries?: number;
  maxUnaryCompressedBytes?: number;
  maxUnaryDecompressedBytes?: number;
}

export class CursorApiHttpError extends Error {
  readonly name = 'CursorApiHttpError';

  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class NodeCursorApiTransport implements CursorApiTransport {
  private readonly endpoint: string;
  private readonly agentEndpoint?: string;
  private readonly fetchImplementation?: typeof globalThis.fetch;
  private readonly runSessions: H2SessionPool;
  private readonly unaryLimits: {
    readonly compressedBytes: number;
    readonly decompressedBytes: number;
  };

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
    this.runSessions = new H2SessionPool(
      options.connect ?? ((endpoint) => http2.connect(endpoint)),
      options.maxSessionPoolEntries,
    );
    this.unaryLimits = {
      compressedBytes: options.maxUnaryCompressedBytes ?? DEFAULT_MAX_UNARY_COMPRESSED_BYTES,
      decompressedBytes: options.maxUnaryDecompressedBytes ?? DEFAULT_MAX_UNARY_DECOMPRESSED_BYTES,
    };
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
    const response = await sendUnaryRequest({
      endpoint: this.endpoint,
      path,
      headers,
      body,
      signal,
      fetch: this.fetchImplementation,
      limits: this.unaryLimits,
    });
    if (response.status < 200 || response.status >= 300) {
      this.throwHttpError(response.status, response.payload);
    }
    return response.payload;
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
    trace?: RequestTrace,
  ): Promise<CursorRunStream> {
    traceRunOpen(trace, 'cursor-api');
    const token = accessToken ?? (await this.options.auth.getToken());
    const traceId = randomBytes(16).toString('hex');
    const spanId = randomBytes(8).toString('hex');
    const traceparent = `00-${traceId}-${spanId}-01`;
    return this.runSessions.openStream({
      endpoint: this.agentEndpoint ?? baseUrl,
      credentialFingerprint: fingerprintCredential(token),
      headers: {
        ':method': 'POST',
        ':path': '/agent.v1.AgentService/Run',
        ...(await this.headers(requestId, false, token)),
        'backend-traceparent': traceparent,
        'connect-accept-encoding': 'gzip,br',
        'connect-content-encoding': 'gzip',
        'connect-protocol-version': '1',
        'content-type': 'application/connect+proto',
        traceparent,
        'x-blob-encryption-key': randomBytes(32).toString('hex'),
        'x-original-request-id': requestId,
      },
      onSessionConnect: () => traceStage(trace, 'h2_session_connect'),
      onStreamOpen: () => traceStage(trace, 'run_stream_open'),
    });
  }

  shutdown(): Promise<void> {
    this.runSessions.shutdown();
    return Promise.resolve();
  }
}
