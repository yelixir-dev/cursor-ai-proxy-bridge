import {
  type CursorApiCredential,
  type CursorApiCredentialInput,
  normalizeCursorApiCredential,
} from './credential-config.js';
import {
  NoEligibleCursorCredentialError,
  credentialSelectionDecision,
  credentialSupportsModel,
  isUltraCredential,
  modelCredentialRequirement,
} from './credential-plan.js';
import {
  type CredentialDisabledReason,
  type CursorCredentialFailoverPolicy,
  type CursorCredentialPolicyConfig,
  type CursorCredentialRoutingPolicy,
  cursorCredentialFailureReason,
} from './credential-policy.js';
import {
  type CursorApiCredentialStateView,
  type CursorCredentialRouteOptions,
  type CursorCredentialRouterOptions,
  NoAvailableCursorCredentialError,
} from './credential-router-types.js';

export type { CursorApiCredential, CursorApiCredentialInput } from './credential-config.js';
export { cursorCredentialsFromConfig } from './credential-config.js';
export type {
  CredentialDisabledReason,
  CursorCredentialFailoverPolicy,
  CursorCredentialPolicyConfig,
  CursorCredentialRoutingPolicy,
} from './credential-policy.js';
export { NoAvailableCursorCredentialError } from './credential-router-types.js';
export type {
  CursorApiCredentialStateView,
  CursorCredentialFailoverDecision,
  CursorCredentialRouteOptions,
  CursorCredentialRouterOptions,
} from './credential-router-types.js';

interface CursorApiCredentialState {
  credential: CursorApiCredential;
  currentWeight: number;
  inFlight: number;
  routerPicks: number;
  disabledReason?: CredentialDisabledReason;
  disabledUntil: number;
}

export function isCredentialAuthFailure(error: unknown): boolean {
  return cursorCredentialFailureReason(error, 'auth') === 'auth';
}

export class CursorCredentialRouter {
  private states: CursorApiCredentialState[] = [];
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private routingPolicy: CursorCredentialRoutingPolicy;
  private failoverOn: CursorCredentialFailoverPolicy;

  constructor(options: CursorCredentialRouterOptions) {
    this.cooldownMs = options.cooldownMs ?? 300_000;
    this.now = options.now ?? Date.now;
    this.routingPolicy = options.routingPolicy ?? 'weighted_round_robin';
    this.failoverOn = options.failoverOn ?? 'auth';
    this.replaceCredentials(options.credentials);
  }

  policy(): CursorCredentialPolicyConfig {
    return {
      routingPolicy: this.routingPolicy,
      failoverOn: this.failoverOn,
    };
  }

  updatePolicy(policy: CursorCredentialPolicyConfig): void {
    if (this.routingPolicy !== policy.routingPolicy) {
      for (const state of this.states) state.currentWeight = 0;
    }
    this.routingPolicy = policy.routingPolicy;
    this.failoverOn = policy.failoverOn;
  }

  replaceCredentials(credentials: CursorApiCredentialInput[]): void {
    const existing = new Map(this.states.map((state) => [state.credential.id, state]));
    const ids = new Set<string>();
    this.states = credentials.map((input) => {
      if (!input.id.trim()) throw new Error('Cursor API credential id must not be empty');
      if (ids.has(input.id)) throw new Error(`Duplicate Cursor API credential id: ${input.id}`);
      ids.add(input.id);
      const credential = normalizeCursorApiCredential(input);
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

  pick(excludeIds: Iterable<string> = [], model?: string): CursorApiCredential {
    const excluded = new Set(excludeIds);
    const now = this.now();
    const available = this.states.filter((state) => {
      this.recoverIfReady(state, now);
      return (
        !excluded.has(state.credential.id) &&
        state.credential.enabled &&
        state.disabledReason === undefined
      );
    });
    let candidates = available.filter((state) => credentialSupportsModel(state.credential, model));
    if (modelCredentialRequirement(model ?? '') === 'ultra' && candidates.length === 0) {
      throw new NoEligibleCursorCredentialError(model ?? '');
    }
    if (this.routingPolicy === 'ultra_last') {
      const nonUltra = candidates.filter((state) => !isUltraCredential(state.credential));
      if (nonUltra.length > 0) candidates = nonUltra;
    }
    if (candidates.length === 0) throw new NoAvailableCursorCredentialError();

    let selected: CursorApiCredentialState | undefined;
    let totalWeight = 0;
    for (const state of candidates) {
      const weight = this.routingPolicy === 'round_robin' ? 1 : state.credential.weight;
      state.currentWeight += weight;
      totalWeight += weight;
      if (!selected || state.currentWeight > selected.currentWeight) selected = state;
    }
    if (!selected) throw new NoAvailableCursorCredentialError();
    selected.currentWeight -= totalWeight;
    selected.inFlight += 1;
    selected.routerPicks += 1;
    return { ...selected.credential };
  }

  pickById(id: string, model?: string): CursorApiCredential {
    const state = this.states.find((candidate) => candidate.credential.id === id);
    if (!state) throw new NoAvailableCursorCredentialError();
    this.recoverIfReady(state, this.now());
    if (!state.credential.enabled || state.disabledReason !== undefined) {
      throw new NoAvailableCursorCredentialError();
    }
    if (!credentialSupportsModel(state.credential, model)) {
      throw new NoEligibleCursorCredentialError(model ?? '');
    }
    state.inFlight += 1;
    state.routerPicks += 1;
    return { ...state.credential };
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
    options: CursorCredentialRouteOptions = {},
  ): Promise<T> {
    const first =
      options.preferredCredentialId === undefined
        ? this.pick([], options.model)
        : this.pickById(options.preferredCredentialId, options.model);
    options.onSelection?.(credentialSelectionDecision(first, options.model, this.routingPolicy));
    try {
      const result = await operation(first);
      this.release(first.id);
      return result;
    } catch (error) {
      const reason = cursorCredentialFailureReason(error, this.failoverOn);
      if (reason === undefined) {
        this.release(first.id);
        throw error;
      }
      this.disable(first.id, reason);
      this.release(first.id);
      if (options.canFailover?.() === false) throw error;

      let second: CursorApiCredential;
      try {
        second = this.pick([first.id], options.model);
      } catch (pickError) {
        if (
          pickError instanceof NoAvailableCursorCredentialError ||
          pickError instanceof NoEligibleCursorCredentialError
        ) {
          throw error;
        }
        throw pickError;
      }
      try {
        options.onFailover?.({
          excludedCredentialId: first.id,
          reason,
          nextCredentialId: second.id,
        });
        options.onSelection?.(
          credentialSelectionDecision(second, options.model, this.routingPolicy),
        );
        const result = await operation(second);
        this.release(second.id);
        return result;
      } catch (retryError) {
        const retryReason = cursorCredentialFailureReason(retryError, this.failoverOn);
        if (retryReason !== undefined) this.disable(second.id, retryReason);
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
