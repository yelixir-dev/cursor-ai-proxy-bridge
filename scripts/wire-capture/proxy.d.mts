import type http2 from 'node:http2';
import type { AddressInfo } from 'node:net';

export interface ParsedFrame {
  flags: number;
  payload: Buffer;
  gunzipped: boolean;
  error?: Error;
}

export interface FrameParserState {
  buf: Buffer | null;
}

export interface CaptureProxyOptions {
  port: number;
  targetHost: string;
  cert: Buffer;
  key: Buffer;
  targetCa?: Buffer;
  captureDir: string;
  log?: (...args: string[]) => void;
}

export interface CaptureProxy {
  server: http2.Http2SecureServer;
  listen: () => Promise<AddressInfo>;
  close: () => Promise<void>;
}

export declare const SENSITIVE: Set<string>;
export declare function redactShape(name: string, value: unknown): string;
export declare function parseFrames(
  state: FrameParserState,
  chunk: Buffer,
  onFrame: (frame: ParsedFrame) => void,
): void;
export declare function fieldPath(buf: Buffer, depth?: number): string[];
export declare function createCaptureProxy(options: CaptureProxyOptions): CaptureProxy;
