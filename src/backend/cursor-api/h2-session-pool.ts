import { createHash } from 'node:crypto';
import type { OutgoingHttpHeaders } from 'node:http2';
import type { CursorRunStream } from './transport.js';

const DEFAULT_MAX_SESSIONS = 8;
const FINGERPRINT_DOMAIN = 'cursor-h2-credential-v1\0';

export interface H2ClientSession {
  readonly closed: boolean;
  readonly destroyed: boolean;
  request(headers: OutgoingHttpHeaders): CursorRunStream;
  close(): void;
  on(event: 'error', listener: (error: Error) => void): this;
  once(event: 'close' | 'goaway', listener: () => void): this;
}

export type H2Connector = (endpoint: string) => H2ClientSession;

export interface H2StreamRequest {
  readonly endpoint: string;
  readonly credentialFingerprint: string;
  readonly headers: OutgoingHttpHeaders;
  readonly onSessionConnect?: () => void;
  readonly onStreamOpen?: () => void;
}

interface SessionEntry {
  readonly key: string;
  readonly session: H2ClientSession;
  readonly streams: Set<CursorRunStream>;
  usable: boolean;
  closeRequested: boolean;
}

export class H2SessionPoolClosedError extends Error {
  readonly name = 'H2SessionPoolClosedError';

  constructor() {
    super('Cursor HTTP/2 session pool is closed');
  }
}

export function fingerprintCredential(credential: string): string {
  return createHash('sha256').update(FINGERPRINT_DOMAIN).update(credential).digest('hex');
}

export class H2SessionPool {
  private readonly entries = new Map<string, SessionEntry>();
  private readonly sessions = new Set<SessionEntry>();
  private closed = false;

  constructor(
    private readonly connect: H2Connector,
    private readonly maxSessions = DEFAULT_MAX_SESSIONS,
  ) {
    if (!Number.isInteger(maxSessions) || maxSessions < 1) {
      throw new RangeError('Cursor HTTP/2 session pool size must be a positive integer');
    }
  }

  openStream(request: H2StreamRequest): CursorRunStream {
    if (this.closed) throw new H2SessionPoolClosedError();
    const endpoint = new URL(request.endpoint).origin;
    const key = `${endpoint}\0${request.credentialFingerprint}`;
    const entry = this.usableEntry(key) ?? this.createEntry(key, endpoint, request);
    try {
      const stream = entry.session.request(request.headers);
      entry.streams.add(stream);
      stream.once('close', () => entry.streams.delete(stream));
      request.onStreamOpen?.();
      return stream;
    } catch (error) {
      this.drain(entry, true);
      throw error;
    }
  }

  shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    this.entries.clear();
    for (const entry of this.sessions) this.closeEntry(entry);
  }

  private usableEntry(key: string): SessionEntry | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.usable && !entry.session.closed && !entry.session.destroyed) return entry;
    this.drain(entry, false);
    return undefined;
  }

  private createEntry(key: string, endpoint: string, request: H2StreamRequest): SessionEntry {
    request.onSessionConnect?.();
    const session = this.connect(endpoint);
    const entry: SessionEntry = {
      key,
      session,
      streams: new Set<CursorRunStream>(),
      usable: true,
      closeRequested: false,
    };
    this.entries.set(key, entry);
    this.sessions.add(entry);
    session.once('goaway', () => this.drain(entry, true));
    session.on('error', (error) => {
      this.drain(entry, false);
      for (const stream of [...entry.streams]) stream.destroy(error);
      this.closeEntry(entry);
    });
    session.once('close', () => {
      this.removeEntry(entry);
      this.sessions.delete(entry);
    });
    this.enforceBound(entry);
    return entry;
  }

  private enforceBound(current: SessionEntry): void {
    while (this.entries.size > this.maxSessions) {
      const oldest = [...this.entries.values()].find((entry) => entry !== current);
      if (!oldest) return;
      this.drain(oldest, true);
    }
  }

  private drain(entry: SessionEntry, close: boolean): void {
    entry.usable = false;
    this.removeEntry(entry);
    if (close) this.closeEntry(entry);
  }

  private removeEntry(entry: SessionEntry): void {
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
  }

  private closeEntry(entry: SessionEntry): void {
    if (entry.closeRequested || entry.session.closed || entry.session.destroyed) return;
    entry.closeRequested = true;
    entry.session.close();
  }
}
