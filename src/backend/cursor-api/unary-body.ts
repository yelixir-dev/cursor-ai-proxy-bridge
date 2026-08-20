import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';

export const DEFAULT_MAX_UNARY_COMPRESSED_BYTES = 8_388_608;
export const DEFAULT_MAX_UNARY_DECOMPRESSED_BYTES = 8_388_608;

export type UnaryBodyLimitKind = 'compressed' | 'decompressed';

export class UnaryBodyLimitError extends Error {
  readonly name = 'UnaryBodyLimitError';

  constructor(
    readonly kind: UnaryBodyLimitKind,
    readonly limit: number,
  ) {
    super(`Cursor unary ${kind} response exceeds ${limit} bytes`);
  }
}

export interface UnaryBodySource extends AsyncIterable<Uint8Array> {
  cancel(error: Error): Promise<void>;
}

export interface UnaryBodyLimits {
  readonly compressedBytes: number;
  readonly decompressedBytes: number;
}

function positiveLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError('Cursor unary body limits must be positive safe integers');
  }
  return value;
}

export async function readUnaryBody(
  source: UnaryBodySource,
  contentEncoding: string | undefined,
  contentLength: number | undefined,
  limits: UnaryBodyLimits,
): Promise<Buffer> {
  const compressedLimit = positiveLimit(limits.compressedBytes);
  const decompressedLimit = positiveLimit(limits.decompressedBytes);
  if (contentLength !== undefined && contentLength > compressedLimit) {
    const error = new UnaryBodyLimitError('compressed', compressedLimit);
    await source.cancel(error);
    throw error;
  }

  let compressedBytes = 0;
  const counted = async function* (): AsyncGenerator<Buffer> {
    for await (const chunk of source) {
      const buffer = Buffer.from(chunk);
      compressedBytes += buffer.length;
      if (compressedBytes > compressedLimit) {
        throw new UnaryBodyLimitError('compressed', compressedLimit);
      }
      yield buffer;
    }
  };
  const gunzip = contentEncoding?.toLowerCase() === 'gzip' ? createGunzip() : undefined;
  const output: AsyncIterable<Uint8Array> = gunzip
    ? Readable.from(counted()).pipe(gunzip)
    : counted();
  const chunks: Buffer[] = [];
  let decompressedBytes = 0;
  try {
    for await (const chunk of output) {
      const buffer = Buffer.from(chunk);
      decompressedBytes += buffer.length;
      if (decompressedBytes > decompressedLimit) {
        throw new UnaryBodyLimitError('decompressed', decompressedLimit);
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks, decompressedBytes);
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    gunzip?.destroy(failure);
    await source.cancel(failure);
    throw failure;
  }
}
