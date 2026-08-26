import {
  type CursorCredentialUsageView,
  type CursorUsageErrorKind,
  isCursorUsageProtocolError,
  parseCursorCredentialUsage,
} from './account-usage-parser.js';
import type { CursorApiCredential } from './credentials.js';

export type {
  CursorCredentialUsageView,
  CursorUsageErrorKind,
  CursorUsagePoolView,
} from './account-usage-parser.js';

const DEFAULT_TTL_MS = 300_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const DASHBOARD_SERVICE = '/aiserver.v1.DashboardService';

export interface CursorUsageTokenProvider {
  getToken(credential: CursorApiCredential, signal?: AbortSignal): Promise<string>;
}

export interface CursorCredentialUsageOptions {
  readonly force?: boolean;
}

type ServiceOptions = {
  readonly auth: CursorUsageTokenProvider;
  readonly fetch?: typeof globalThis.fetch;
  readonly apiEndpoint?: string;
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly timeoutMs?: number;
};

class CursorUsageRpcError extends Error {
  constructor(readonly status: number) {
    super(`Cursor usage RPC failed with HTTP ${status}`);
  }
}

function usageError(error: unknown): CursorUsageErrorKind {
  if (error instanceof CursorUsageRpcError && (error.status === 401 || error.status === 403)) {
    return 'auth';
  }
  return isCursorUsageProtocolError(error) ? 'protocol' : 'upstream';
}

export class CursorCredentialUsageService {
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly endpoint: string;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly cache = new Map<string, CursorCredentialUsageView>();
  private readonly refreshes = new Map<string, Promise<CursorCredentialUsageView>>();

  constructor(private readonly options: ServiceOptions) {
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    this.endpoint = (options.apiEndpoint ?? 'https://api2.cursor.sh').replace(/\/$/, '');
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async snapshots(
    credentials: CursorApiCredential[],
    options: CursorCredentialUsageOptions = {},
  ): Promise<CursorCredentialUsageView[]> {
    return Promise.all(
      credentials.map((credential) => this.snapshot(credential, options.force === true)),
    );
  }

  invalidate(): void {
    this.cache.clear();
  }

  private async snapshot(
    credential: CursorApiCredential,
    force: boolean,
  ): Promise<CursorCredentialUsageView> {
    const cached = this.cache.get(credential.id);
    if (!force && cached?.fetchedAt !== undefined && this.now() - cached.fetchedAt < this.ttlMs) {
      return cached;
    }
    let refresh = this.refreshes.get(credential.id);
    if (!refresh) {
      refresh = this.refresh(credential).finally(() => this.refreshes.delete(credential.id));
      this.refreshes.set(credential.id, refresh);
    }
    try {
      const fresh = await refresh;
      this.cache.set(credential.id, fresh);
      return fresh;
    } catch (error) {
      return {
        id: credential.id,
        ...(credential.label === undefined ? {} : { label: credential.label }),
        enabled: credential.enabled,
        status: cached ? 'stale' : 'unavailable',
        ...(cached?.fetchedAt === undefined ? {} : { fetchedAt: cached.fetchedAt }),
        pools: cached?.pools ?? { cursorModels: {}, otherModels: {} },
        ...(cached?.plan === undefined ? {} : { plan: cached.plan }),
        ...(cached?.cycle === undefined ? {} : { cycle: cached.cycle }),
        ...(cached?.included === undefined ? {} : { included: cached.included }),
        ...(cached?.onDemand === undefined ? {} : { onDemand: cached.onDemand }),
        error: { kind: usageError(error) },
      };
    }
  }

  private async refresh(credential: CursorApiCredential): Promise<CursorCredentialUsageView> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    const token = await this.options.auth.getToken(credential, signal);
    const [usageValue, planValue] = await Promise.all([
      this.post('GetCurrentPeriodUsage', token, signal),
      this.post('GetPlanInfo', token, signal),
    ]);
    return parseCursorCredentialUsage(credential, this.now(), usageValue, planValue);
  }

  private async post(method: string, token: string, signal: AbortSignal): Promise<unknown> {
    const response = await this.fetchImplementation(
      `${this.endpoint}${DASHBOARD_SERVICE}/${method}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'connect-protocol-version': '1',
          'content-type': 'application/json',
          'user-agent': 'connect-es/1.6.1',
        },
        body: '{}',
        signal,
      },
    );
    if (!response.ok) throw new CursorUsageRpcError(response.status);
    return response.json();
  }
}
