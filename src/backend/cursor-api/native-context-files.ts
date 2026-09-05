import { posix } from 'node:path';
import { parseDocument } from 'yaml';
import { awaitWithAbort } from './auth.js';

export function identity(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(value))
    throw new Error('Invalid native context identity');
  return value;
}

export function relativeSourcePath(value: string): string {
  if (
    !value ||
    /[\\%?#]/.test(value) ||
    hasControlCharacters(value) ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error('Invalid native context source path');
  }
  return value;
}

export function absoluteContextPath(value: string): string {
  if (!posix.isAbsolute(value) || value.includes('\\') || hasControlCharacters(value))
    throw new Error('Native context requires an absolute path');
  return posix.resolve(value);
}

export function hasControlCharacters(value: string): boolean {
  return Array.from(value).some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
}

/** No tags, objects, executable constructors, or unbounded aliases from remote YAML. */
export function frontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return { data: {}, body: normalized.trim() };
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/.exec(normalized);
  if (!match || match[1] === undefined || match[2] === undefined)
    throw new Error('Invalid native context frontmatter');
  try {
    const document = parseDocument(match[1], { schema: 'core', uniqueKeys: true });
    if (document.errors.length || document.warnings.length) throw new Error('Invalid YAML');
    const data: unknown = document.toJS({ maxAliasCount: 0 });
    if (data === null) return { data: {}, body: match[2].trim() };
    if (typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid YAML mapping');
    return { data: data as Record<string, unknown>, body: match[2].trim() };
  } catch {
    // YAML errors contain source excerpts: do not leak account prompts into error logs.
    throw new Error('Invalid native context frontmatter');
  }
}

export function stringList(value: unknown): string[] {
  if (value === undefined) return [];
  if (typeof value === 'string')
    return value
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
  if (Array.isArray(value) && value.every((item) => typeof item === 'string'))
    return value.filter(Boolean);
  throw new Error('Invalid native context frontmatter list');
}

export function metadataOf(data: Record<string, unknown>): Record<string, unknown> {
  const metadata = data.metadata;
  if (metadata === undefined) return {};
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
    throw new Error('Invalid native context frontmatter metadata');
  return metadata as Record<string, unknown>;
}

export function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Only public, pinned GitHub content is supported; neither RPC tokens nor redirects are used. */
export function githubSource(gitUrl: string, gitRef: string, gitPath: string) {
  let repository: URL;
  try {
    repository = new URL(gitUrl);
  } catch {
    throw new Error('Invalid native plugin source');
  }
  if (
    repository.protocol !== 'https:' ||
    repository.hostname !== 'github.com' ||
    repository.port ||
    repository.username ||
    repository.password ||
    repository.search ||
    repository.hash
  )
    throw new Error('Unsupported native plugin source');
  const parts = repository.pathname
    .replace(/\.git$/, '')
    .replace(/^\//, '')
    .split('/');
  if (parts.length !== 2) throw new Error('Invalid native plugin source');
  parts.forEach(identity);
  if (!/^[a-fA-F0-9]{40}$/.test(gitRef)) throw new Error('Native plugin requires a pinned commit');
  if (gitPath) relativeSourcePath(gitPath);
  const repo = parts.join('/');
  const raw = (path: string) =>
    'https://raw.githubusercontent.com/' +
    repo +
    '/' +
    gitRef +
    '/' +
    relativeSourcePath(path).split('/').map(encodeURIComponent).join('/');
  return {
    raw,
    relative(path: string, sourceUrl: string): string {
      relativeSourcePath(path);
      if (gitPath && !path.startsWith(gitPath + '/'))
        throw new Error('Native plugin source path escapes gitPath');
      const relative = gitPath ? path.slice(gitPath.length + 1) : path;
      relativeSourcePath(relative);
      if (sourceUrl) {
        let source: URL;
        try {
          source = new URL(sourceUrl);
        } catch {
          throw new Error('Invalid native plugin source URL');
        }
        // Metadata may use a branch URL; fetch only the selected immutable commit instead.
        const prefix = source.hostname === 'github.com' ? '/' + repo + '/blob/' : '/' + repo + '/';
        if (
          source.protocol !== 'https:' ||
          !['github.com', 'raw.githubusercontent.com'].includes(source.hostname) ||
          source.port ||
          source.username ||
          source.password ||
          source.search ||
          source.hash ||
          !source.pathname.startsWith(prefix)
        )
          throw new Error('Invalid native plugin source URL');
        const tail = source.pathname.slice(prefix.length);
        const slash = tail.indexOf('/');
        if (slash < 1 || decodeURIComponent(tail.slice(slash + 1)) !== path)
          throw new Error('Native plugin source URL does not match source path');
      }
      return relative;
    },
  };
}

export interface SourceReaderOptions {
  fetch: typeof globalThis.fetch;
  signal: AbortSignal;
  maxSourceBytes?: number;
  maxTotalSourceBytes?: number;
  maxSourceFiles?: number;
  sourceTimeoutMs?: number;
}

export class NativeSourceReader {
  private readonly cache = new Map<string, string>();
  private readonly pending = new Set<Promise<string>>();
  private totalBytes = 0;
  private attempts = 0;
  private readonly maxBytes: number;
  private readonly maxTotalBytes: number;
  private readonly maxFiles: number;
  private readonly timeout: number;

  constructor(private readonly options: SourceReaderOptions) {
    this.maxBytes = options.maxSourceBytes ?? 1_048_576;
    this.maxTotalBytes = options.maxTotalSourceBytes ?? 33_554_432;
    this.maxFiles = options.maxSourceFiles ?? 512;
    this.timeout = options.sourceTimeoutMs ?? 15_000;
    for (const limit of [this.maxBytes, this.maxTotalBytes, this.maxFiles, this.timeout]) {
      if (!Number.isSafeInteger(limit) || limit <= 0)
        throw new Error('Invalid native source limit');
    }
  }

  async read(url: string, callerSignal?: AbortSignal): Promise<string> {
    const signal = AbortSignal.any([
      this.options.signal,
      ...(callerSignal ? [callerSignal] : []),
      AbortSignal.timeout(this.timeout),
    ]);
    signal.throwIfAborted();
    const cached = this.cache.get(url);
    if (cached !== undefined) return cached;
    // Four active reads, including lazy reads. Waiting consumes the same bounded deadline.
    while (this.pending.size >= 4) {
      // Queue waiters need a free slot, not another caller's result. The original
      // operation is still awaited below by its owner and retains its rejection.
      const settled = [...this.pending].map((operation) =>
        operation.then(
          () => undefined,
          () => undefined,
        ),
      );
      await awaitWithAbort(Promise.race(settled), signal);
    }
    signal.throwIfAborted();
    const nowCached = this.cache.get(url);
    if (nowCached !== undefined) return nowCached;
    if (++this.attempts > this.maxFiles) throw new Error('Native source file limit exceeded');
    const operation = this.fetchText(url, signal);
    this.pending.add(operation);
    try {
      const text = await operation;
      signal.throwIfAborted();
      this.totalBytes += Buffer.byteLength(text);
      if (this.totalBytes > this.maxTotalBytes)
        throw new Error('Native source total byte limit exceeded');
      this.cache.set(url, text);
      return text;
    } finally {
      this.pending.delete(operation);
    }
  }

  private async fetchText(url: string, signal: AbortSignal): Promise<string> {
    const response = await awaitWithAbort(
      this.options.fetch(url, { signal, credentials: 'omit', redirect: 'error' }),
      signal,
    );
    if (!response.ok) {
      if (response.body) await awaitWithAbort(response.body.cancel(), signal);
      throw new Error('Native plugin source fetch failed: HTTP ' + response.status);
    }
    const length = response.headers.get('content-length');
    if (length && Number(length) > this.maxBytes) {
      if (response.body) await awaitWithAbort(response.body.cancel(), signal);
      throw new Error('Native source byte limit exceeded');
    }
    if (!response.body) return '';
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let complete = false;
    try {
      for (;;) {
        const item = await awaitWithAbort(reader.read(), signal);
        if (item.done) {
          complete = true;
          break;
        }
        bytes += item.value.byteLength;
        if (bytes > this.maxBytes) throw new Error('Native source byte limit exceeded');
        chunks.push(item.value);
      }
      return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    } finally {
      try {
        if (!complete) await awaitWithAbort(reader.cancel(), signal);
      } finally {
        reader.releaseLock();
      }
    }
  }
}
