import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CursorApiCredential } from './credentials.js';
import { CursorApiHttpError } from './transport.js';

const execFileAsync = promisify(execFile);
const REFRESH_SKEW_SECONDS = 300;

export interface AuthProviderOptions {
  environment?: NodeJS.ProcessEnv;
  apiEndpoint?: string;
  now?: () => number;
  keychain?: () => Promise<string>;
  fetch?: typeof globalThis.fetch;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

export function awaitWithAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function jwtExpiration(token: string): number | undefined {
  const payload = token.split('.')[1];
  if (!payload) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      exp?: unknown;
    };
    return typeof decoded.exp === 'number' && Number.isFinite(decoded.exp)
      ? decoded.exp
      : undefined;
  } catch {
    return undefined;
  }
}

async function macOsKeychainToken(): Promise<string> {
  if (process.platform !== 'darwin') {
    throw new Error('macOS Keychain authentication is unavailable on this platform');
  }
  const { stdout } = await execFileAsync('/usr/bin/security', [
    'find-generic-password',
    '-s',
    'cursor-access-token',
    '-a',
    'cursor-user',
    '-w',
  ]);
  return stdout.trim();
}

export class CursorAuthProvider {
  private readonly environment: NodeJS.ProcessEnv;
  private readonly endpoint: string;
  private readonly now: () => number;
  private readonly readKeychain: () => Promise<string>;
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly cached = new Map<
    string,
    { token: string; expiration?: number; source: 'env' | 'keychain' | 'api-key' }
  >();
  private readonly refreshes = new Map<string, Promise<string>>();

  constructor(options: AuthProviderOptions = {}) {
    this.environment = options.environment ?? process.env;
    this.endpoint = (
      options.apiEndpoint ??
      this.environment.CURSOR_BRIDGE_CURSOR_API_ENDPOINT ??
      this.environment.CURSOR_API_ENDPOINT ??
      'https://api2.cursor.sh'
    ).replace(/\/$/, '');
    this.now = options.now ?? (() => Date.now());
    this.readKeychain = options.keychain ?? macOsKeychainToken;
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
  }

  configured(): boolean {
    return Boolean(
      this.environment.CURSOR_AUTH_TOKEN ||
      this.environment.CURSOR_API_KEY ||
      process.platform === 'darwin',
    );
  }

  async getToken(
    credential: CursorApiCredential = {
      id: 'system',
      weight: 1,
      enabled: true,
    },
    signal?: AbortSignal,
  ): Promise<string> {
    const cached = this.cached.get(credential.id);
    if (cached && !this.needsRefresh(cached.expiration)) return cached.token;
    let refresh = this.refreshes.get(credential.id);
    if (!refresh) {
      refresh = this.refreshToken(credential).finally(() => {
        this.refreshes.delete(credential.id);
      });
      this.refreshes.set(credential.id, refresh);
    }
    return awaitWithAbort(refresh, signal);
  }

  invalidate(id?: string): void {
    if (id === undefined) {
      this.cached.clear();
      return;
    }
    this.cached.delete(id);
  }

  private needsRefresh(expiration: number | undefined): boolean {
    return (
      expiration !== undefined && expiration - Math.floor(this.now() / 1000) < REFRESH_SKEW_SECONDS
    );
  }

  private remember(id: string, token: string, source: 'env' | 'keychain' | 'api-key'): string {
    const trimmed = token.trim();
    if (!trimmed) throw new Error('Cursor authentication token is empty');
    this.cached.set(id, { token: trimmed, expiration: jwtExpiration(trimmed), source });
    return trimmed;
  }

  private async refreshToken(credential: CursorApiCredential): Promise<string> {
    if (credential.apiKey) return this.exchangeApiKey(credential.id, credential.apiKey);

    const direct = this.environment.CURSOR_AUTH_TOKEN?.trim();
    const apiKey = this.environment.CURSOR_API_KEY?.trim();
    if (direct && !this.needsRefresh(jwtExpiration(direct))) {
      return this.remember(credential.id, direct, 'env');
    }
    if (apiKey) return this.exchangeApiKey(credential.id, apiKey);
    try {
      return this.remember(credential.id, await this.readKeychain(), 'keychain');
    } catch (error) {
      if (direct) return this.remember(credential.id, direct, 'env');
      throw new Error(
        `Cursor authentication unavailable. Set CURSOR_AUTH_TOKEN or CURSOR_API_KEY, or log in with Cursor so the macOS Keychain contains cursor-access-token (${error instanceof Error ? error.message : String(error)}).`,
        { cause: error },
      );
    }
  }

  private async exchangeApiKey(id: string, apiKey: string): Promise<string> {
    const response = await this.fetchImplementation(`${this.endpoint}/auth/exchange_user_api_key`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'user-agent': 'connect-es/1.6.1',
      },
      body: '{}',
    });
    if (!response.ok) {
      throw new CursorApiHttpError(
        response.status,
        `Cursor API key exchange failed with HTTP ${response.status}`,
      );
    }
    const payload = (await response.json()) as { accessToken?: unknown };
    if (typeof payload.accessToken !== 'string' || !payload.accessToken.trim()) {
      throw new Error('Cursor API key exchange response did not contain accessToken');
    }
    return this.remember(id, payload.accessToken, 'api-key');
  }
}
