import type { CursorApiCredentialInput } from './credential-config.js';
import type { CursorCredentialSelectionDecision } from './credential-plan.js';
import type {
  CredentialDisabledReason,
  CursorCredentialFailoverPolicy,
  CursorCredentialRoutingPolicy,
} from './credential-policy.js';

export interface CursorApiCredentialStateView {
  id: string;
  label?: string;
  enabled: boolean;
  disabledReason?: CredentialDisabledReason;
  disabledUntil?: number;
  inFlight: number;
  routerPicks: number;
}

export interface CursorCredentialRouterOptions {
  credentials: CursorApiCredentialInput[];
  cooldownMs?: number;
  now?: () => number;
  routingPolicy?: CursorCredentialRoutingPolicy;
  failoverOn?: CursorCredentialFailoverPolicy;
}

export interface CursorCredentialFailoverDecision {
  readonly excludedCredentialId: string;
  readonly reason: CredentialDisabledReason;
  readonly nextCredentialId: string;
}

export interface CursorCredentialRouteOptions {
  readonly canFailover?: () => boolean;
  readonly model?: string;
  readonly preferredCredentialId?: string;
  readonly onFailover?: (decision: CursorCredentialFailoverDecision) => void;
  readonly onSelection?: (decision: CursorCredentialSelectionDecision) => void;
}

export class NoAvailableCursorCredentialError extends Error {
  constructor(message = 'No enabled Cursor API credentials are available') {
    super(message);
    this.name = 'NoAvailableCursorCredentialError';
  }
}
