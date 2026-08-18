import { gunzipSync, gzipSync } from 'node:zlib';

export const CONNECT_FLAG_COMPRESSED = 0x01;
export const CONNECT_FLAG_END_STREAM = 0x02;

export interface ConnectFrame {
  flags: number;
  payload?: Buffer;
  trailer?: Record<string, unknown>;
}

export class ConnectRpcError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly details?: unknown,
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

  push(chunk: Uint8Array): ConnectFrame[] {
    this.buffered = Buffer.concat([this.buffered, Buffer.from(chunk)]);
    const frames: ConnectFrame[] = [];
    while (this.buffered.length >= 5) {
      const flags = this.buffered[0]!;
      const length = this.buffered.readUInt32BE(1);
      if (this.buffered.length < length + 5) break;
      let payload = this.buffered.subarray(5, length + 5);
      this.buffered = this.buffered.subarray(length + 5);
      if (flags & CONNECT_FLAG_COMPRESSED) {
        try {
          payload = gunzipSync(payload);
        } catch (error) {
          throw new ConnectRpcError(
            `Invalid gzip Connect frame: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (flags & CONNECT_FLAG_END_STREAM) {
        let trailer: Record<string, unknown>;
        try {
          trailer = JSON.parse(payload.toString('utf8') || '{}') as Record<string, unknown>;
        } catch {
          throw new ConnectRpcError('Invalid Connect end-stream trailer JSON');
        }
        const rpcError = trailer.error as
          | { code?: unknown; message?: unknown; details?: unknown }
          | undefined;
        if (rpcError) {
          throw new ConnectRpcError(
            typeof rpcError.message === 'string' ? rpcError.message : 'Cursor Connect RPC failed',
            typeof rpcError.code === 'string' ? rpcError.code : undefined,
            rpcError.details,
          );
        }
        frames.push({ flags, trailer });
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
