import { ConnectRpcError } from './connect-frame.js';
import { CursorApiHttpError } from './transport.js';

export type CredentialDisabledReason = 'auth' | 'cooldown';

export interface CursorApiCredential {
  id: string;
  label?: string;
  apiKey?: string;
  weight: number;
  enabled: boolean;
}

export interface CursorApiCredentialInput {
  id: string;
  label?: string;
  apiKey?: string;
  weight?: number;
  enabled?: boolean;
}

export interface CursorApiCredentialStateView {
  id: string;
  label?: string;
  enabled: boolean;
  disabledReason?: CredentialDisabledReason;
  disabledUntil?: number;
  inFlight: number;
  routerPicks: number;
}

interface CursorApiCredentialState {
  credential: CursorApiCredential;
  currentWeight: number;
  inFlight: number;
  routerPicks: number;
  disabledReason?: CredentialDisabledReason;
  disabledUntil: number;
}

export interface CursorCredentialRouterOptions {
  credentials: CursorApiCredentialInput[];
  cooldownMs?: number;
  now?: () => number;
}

export class NoAvailableCursorCredentialError extends Error {
  constructor(message = 'No enabled Cursor API credentials are available') {
    super(message);
    this.name = 'NoAvailableCursorCredentialError';
  }
}

function positiveWeight(value: number | undefined): number {
  return Number.isFinite(value) && value !== undefined && value > 0 ? value : 1;
}

function normalizeCredential(credential: CursorApiCredentialInput): CursorApiCredential {
  const normalized: CursorApiCredential = {
    id: credential.id,
    weight: positiveWeight(credential.weight),
    enabled: credential.enabled !== false,
  };
  if (credential.label !== undefined) normalized.label = credential.label;
  if (credential.apiKey !== undefined) normalized.apiKey = credential.apiKey;
  return normalized;
}

export function cursorCredentialsFromConfig(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
  dashboardCredentials: CursorApiCredentialInput[] = [],
): CursorApiCredential[] {
  const credentials: CursorApiCredential[] = [];
  const envApiKey = environment.CURSOR_API_KEY?.trim();
  if (envApiKey) credentials.push(normalizeCredential({ id: 'env', apiKey: envApiKey }));

  const used = new Set(credentials.map((credential) => credential.id));
  for (const credential of dashboardCredentials) {
    if (used.has(credential.id)) continue;
    used.add(credential.id);
    credentials.push(normalizeCredential(credential));
  }

  if (credentials.length === 0) {
    credentials.push(normalizeCredential({ id: 'system' }));
  }
  return credentials;
}

export function isCredentialAuthFailure(error: unknown): boolean {
  if (error instanceof CursorApiHttpError) return error.status === 401 || error.status === 403;
  if (error instanceof ConnectRpcError) {
    return error.code === 'unauthenticated' || error.code === 'permission_denied';
  }
  if (error && typeof error === 'object' && 'status' in error) {
    const status = Number((error as { status?: unknown }).status);
    return status === 401 || status === 403;
  }
  return false;
}

export class CursorCredentialRouter {
  private states: CursorApiCredentialState[] = [];
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(options: CursorCredentialRouterOptions) {
    this.cooldownMs = options.cooldownMs ?? 300_000;
    this.now = options.now ?? Date.now;
    this.replaceCredentials(options.credentials);
  }

  replaceCredentials(credentials: CursorApiCredentialInput[]): void {
    const existing = new Map(this.states.map((state) => [state.credential.id, state]));
    const ids = new Set<string>();
    this.states = credentials.map((input) => {
      if (!input.id.trim()) throw new Error('Cursor API credential id must not be empty');
      if (ids.has(input.id)) throw new Error(`Duplicate Cursor API credential id: ${input.id}`);
      ids.add(input.id);
      const credential = normalizeCredential(input);
      const previous = existing.get(credential.id);
      if (previous) {
        const credentialsChanged =
          previous.credential.apiKey !== credential.apiKey ||
          (!previous.credential.enabled && credential.enabled);
        return {
          ...previous,
          credential,
          ...(credentialsChanged ? { disabledReason: undefined, disabledUntil: 0 } : {}),
        };
      }
      return {
        credential,
        currentWeight: 0,
        inFlight: 0,
        routerPicks: 0,
        disabledUntil: 0,
      };
    });
  }

  credentials(): CursorApiCredential[] {
    return this.states.map((state) => ({ ...state.credential }));
  }

  snapshot(): CursorApiCredentialStateView[] {
    const now = this.now();
    return this.states.map((state) => {
      this.recoverIfReady(state, now);
      const view: CursorApiCredentialStateView = {
        id: state.credential.id,
        enabled: state.credential.enabled,
        inFlight: state.inFlight,
        routerPicks: state.routerPicks,
      };
      if (state.credential.label !== undefined) view.label = state.credential.label;
      if (state.disabledReason !== undefined) view.disabledReason = state.disabledReason;
      if (state.disabledUntil > now) view.disabledUntil = state.disabledUntil;
      return view;
    });
  }

  pick(excludeIds: Iterable<string> = []): CursorApiCredential {
    const excluded = new Set(excludeIds);
    const now = this.now();
    const candidates = this.states.filter((state) => {
      this.recoverIfReady(state, now);
      return (
        !excluded.has(state.credential.id) &&
        state.credential.enabled &&
        state.disabledReason === undefined
      );
    });
    if (candidates.length === 0) throw new NoAvailableCursorCredentialError();

    let selected: CursorApiCredentialState | undefined;
    let totalWeight = 0;
    for (const state of candidates) {
      state.currentWeight += state.credential.weight;
      totalWeight += state.credential.weight;
      if (!selected || state.currentWeight > selected.currentWeight) selected = state;
    }
    if (!selected) throw new NoAvailableCursorCredentialError();
    selected.currentWeight -= totalWeight;
    selected.inFlight += 1;
    selected.routerPicks += 1;
    return { ...selected.credential };
  }

  release(id: string): void {
    const state = this.states.find((candidate) => candidate.credential.id === id);
    if (state) state.inFlight = Math.max(0, state.inFlight - 1);
  }

  disable(id: string, reason: CredentialDisabledReason): void {
    const state = this.states.find((candidate) => candidate.credential.id === id);
    if (!state) return;
    state.disabledReason = reason;
    state.disabledUntil = this.now() + this.cooldownMs;
  }

  async route<T>(
    operation: (credential: CursorApiCredential) => Promise<T>,
    canFailover: () => boolean = () => true,
  ): Promise<T> {
    const first = this.pick();
    try {
      const result = await operation(first);
      this.release(first.id);
      return result;
    } catch (error) {
      if (!isCredentialAuthFailure(error)) {
        this.release(first.id);
        throw error;
      }
      this.disable(first.id, 'auth');
      this.release(first.id);
      if (!canFailover()) throw error;

      let second: CursorApiCredential;
      try {
        second = this.pick([first.id]);
      } catch (pickError) {
        if (pickError instanceof NoAvailableCursorCredentialError) throw error;
        throw pickError;
      }
      try {
        const result = await operation(second);
        this.release(second.id);
        return result;
      } catch (retryError) {
        if (isCredentialAuthFailure(retryError)) this.disable(second.id, 'auth');
        this.release(second.id);
        throw retryError;
      }
    }
  }

  private recoverIfReady(state: CursorApiCredentialState, now: number): void {
    if (state.disabledReason !== undefined && state.disabledUntil <= now) {
      state.disabledReason = undefined;
      state.disabledUntil = 0;
    }
  }
}
