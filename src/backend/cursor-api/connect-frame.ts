import { gunzipSync, gzipSync } from 'node:zlib';

export const CONNECT_FLAG_COMPRESSED = 0x01;
export const CONNECT_FLAG_END_STREAM = 0x02;

export interface ConnectFrame {
  flags: number;
  payload?: Buffer;
  trailer?: Record<string, unknown>;
  error?: ConnectRpcError;
}

export class ConnectRpcError extends Error {
  inferenceErrorType?: string;
  runRequestId?: string;

  constructor(
    message: string,
    readonly code?: string,
    readonly details?: unknown,
    readonly terminal = false,
  ) {
    super(message);
    this.name = 'ConnectRpcError';
  }
}

export function encodeConnectFrame(
  payload: Uint8Array,
  options: { compressed?: boolean; trailer?: boolean } = {},
): Buffer {
  const encoded = options.compressed ? gzipSync(payload) : Buffer.from(payload);
  const frame = Buffer.allocUnsafe(5 + encoded.length);
  frame[0] =
    (options.compressed ? CONNECT_FLAG_COMPRESSED : 0) |
    (options.trailer ? CONNECT_FLAG_END_STREAM : 0);
  frame.writeUInt32BE(encoded.length, 1);
  encoded.copy(frame, 5);
  return frame;
}

export class ConnectFrameDecoder {
  private buffered = Buffer.alloc(0);
  private decodedBytes = 0;
  private encodedBytes = 0;
  private ended = false;

  constructor(private readonly maxPayloadBytes = 8_388_608) {}

  get rawOutputBytes(): number {
    return this.encodedBytes;
  }

  push(chunk: Uint8Array): ConnectFrame[] {
    if (this.ended) return [];
    const previousBufferedLength = this.buffered.length;
    this.encodedBytes += chunk.byteLength;
    this.buffered = Buffer.concat([this.buffered, Buffer.from(chunk)]);
    const frames: ConnectFrame[] = [];
    let consumedBytes = 0;
    while (this.buffered.length >= 5) {
      const flags = this.buffered.readUInt8(0);
      if (flags & ~(CONNECT_FLAG_COMPRESSED | CONNECT_FLAG_END_STREAM)) {
        throw new ConnectRpcError('Connect frame has unsupported flag bits');
      }
      const length = this.buffered.readUInt32BE(1);
      if (this.buffered.length < length + 5) break;
      consumedBytes += length + 5;
      let payload = this.buffered.subarray(5, length + 5);
      this.buffered = this.buffered.subarray(length + 5);
      const remainingBytes = this.maxPayloadBytes - this.decodedBytes;
      if (remainingBytes < 0) {
        throw new ConnectRpcError(
          `Connect frame decoded payload exceeds ${this.maxPayloadBytes} bytes`,
        );
      }
      if (flags & CONNECT_FLAG_COMPRESSED) {
        try {
          payload = gunzipSync(payload, { maxOutputLength: Math.max(1, remainingBytes) });
        } catch (error) {
          if (
            error instanceof Error &&
            error.message.includes('Cannot create a Buffer larger than')
          ) {
            throw new ConnectRpcError(
              `Connect frame decoded payload exceeds ${this.maxPayloadBytes} bytes`,
            );
          }
          throw new ConnectRpcError(
            `Invalid gzip Connect frame: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (payload.length > remainingBytes) {
        throw new ConnectRpcError(
          `Connect frame decoded payload exceeds ${this.maxPayloadBytes} bytes`,
        );
      }
      this.decodedBytes += payload.length;
      if (flags & CONNECT_FLAG_END_STREAM) {
        const acceptedFromChunk = Math.max(
          0,
          Math.min(chunk.byteLength, consumedBytes - previousBufferedLength),
        );
        this.encodedBytes -= chunk.byteLength - acceptedFromChunk;
        let trailer: Record<string, unknown> = {};
        let error: ConnectRpcError | undefined;
        try {
          const decoded: unknown = JSON.parse(payload.toString('utf8') || '{}');
          if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
            error = new ConnectRpcError(
              'Invalid Connect end-stream trailer object',
              undefined,
              undefined,
              true,
            );
          } else {
            trailer = decoded as Record<string, unknown>;
          }
        } catch {
          error = new ConnectRpcError(
            'Invalid Connect end-stream trailer JSON',
            undefined,
            undefined,
            true,
          );
        }
        if (!error && Object.hasOwn(trailer, 'error')) {
          const rpcError = trailer.error;
          if (rpcError === null || typeof rpcError !== 'object' || Array.isArray(rpcError)) {
            error = new ConnectRpcError(
              'Invalid Connect end-stream error object',
              undefined,
              undefined,
              true,
            );
          } else {
            const fields = rpcError as Record<string, unknown>;
            error = new ConnectRpcError(
              typeof fields.message === 'string' ? fields.message : 'Cursor Connect RPC failed',
              typeof fields.code === 'string' ? fields.code : undefined,
              fields.details,
              true,
            );
          }
        }
        this.ended = true;
        this.buffered = Buffer.alloc(0);
        if (error && frames.length === 0) throw error;
        frames.push({
          flags,
          trailer,
          error,
        });
        break;
      } else {
        frames.push({ flags, payload: Buffer.from(payload) });
      }
    }
    return frames;
  }

  finish(): void {
    if (this.buffered.length > 0) throw new ConnectRpcError('Truncated Connect frame');
  }
}
