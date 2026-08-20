import type { IncomingMessage } from 'node:http';
import https from 'node:https';
import { readUnaryBody, type UnaryBodyLimits, type UnaryBodySource } from './unary-body.js';

type Headers = Record<string, string>;

export interface UnaryRequestOptions {
  readonly endpoint: string;
  readonly path: string;
  readonly headers: Headers;
  readonly body: Uint8Array;
  readonly signal?: AbortSignal;
  readonly fetch?: typeof globalThis.fetch;
  readonly limits: UnaryBodyLimits;
}

export interface UnaryResponse {
  readonly status: number;
  readonly payload: Buffer;
}

function contentLength(value: string | string[] | null | undefined): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw === null || raw === '') return undefined;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function fetchBodySource(response: Response): UnaryBodySource {
  const reader = response.body?.getReader();
  if (!reader) {
    return {
      async *[Symbol.asyncIterator]() {},
      cancel: () => Promise.resolve(),
    };
  }
  return {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        const item = await reader.read();
        if (item.done) return;
        yield item.value;
      }
    },
    async cancel(error) {
      await reader.cancel(error);
    },
  };
}

function incomingBodySource(response: IncomingMessage): UnaryBodySource {
  return {
    [Symbol.asyncIterator]: () => response[Symbol.asyncIterator](),
    cancel(error) {
      response.destroy(error);
      return Promise.resolve();
    },
  };
}

export async function sendUnaryRequest(options: UnaryRequestOptions): Promise<UnaryResponse> {
  if (options.fetch) {
    const response = await options.fetch(`${options.endpoint}${options.path}`, {
      method: 'POST',
      headers: options.headers,
      body: Buffer.from(options.body),
      signal: options.signal,
    });
    return {
      status: response.status,
      payload: await readUnaryBody(
        fetchBodySource(response),
        response.headers.get('content-encoding') ?? undefined,
        contentLength(response.headers.get('content-length')),
        options.limits,
      ),
    };
  }
  return new Promise<UnaryResponse>((resolve, reject) => {
    const request = https.request(
      `${options.endpoint}${options.path}`,
      {
        method: 'POST',
        headers:
          options.body.byteLength === 0
            ? { ...options.headers, 'content-length': '0' }
            : { ...options.headers, 'transfer-encoding': 'chunked' },
        signal: options.signal,
      },
      (response) => {
        void readUnaryBody(
          incomingBodySource(response),
          response.headers['content-encoding'],
          contentLength(response.headers['content-length']),
          options.limits,
        ).then((payload) => resolve({ status: response.statusCode ?? 0, payload }), reject);
      },
    );
    request.once('error', reject);
    request.end(Buffer.from(options.body));
  });
}
