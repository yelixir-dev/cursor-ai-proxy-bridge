import type { CursorCredentialRoutingPolicy } from './credential-policy.js';

export const CURSOR_CREDENTIAL_PLANS = ['ultra', 'pro_plus', 'pro', 'other'] as const;
export type CursorCredentialPlan = (typeof CURSOR_CREDENTIAL_PLANS)[number];

export type CursorCredentialCapabilities = {
  readonly fable?: boolean;
};

export type CursorCredentialCapabilityView = {
  readonly plan?: CursorCredentialPlan;
  readonly capabilities?: CursorCredentialCapabilities;
};

export type CursorCredentialSelectionView = CursorCredentialCapabilityView & {
  readonly id: string;
};

export type CursorCredentialSelectionDecision = {
  readonly selectedCredentialId: string;
  readonly selectedPlan: CursorCredentialPlan | 'unclassified';
  readonly eligibility: 'fable_capable' | 'standard';
  readonly routingPolicy: CursorCredentialRoutingPolicy;
  readonly ultraReserveBypassed: boolean;
};

export type CursorModelCredentialRequirement = 'ultra';

export class NoEligibleCursorCredentialError extends Error {
  constructor(readonly model: string) {
    super(
      `Model ${model} requires an Ultra credential; no eligible Ultra credential is currently available`,
    );
    this.name = 'NoEligibleCursorCredentialError';
  }
}

export function modelCredentialRequirement(
  model: string,
): CursorModelCredentialRequirement | undefined {
  const normalized = model.toLowerCase().replace(/^claude-/u, '');
  return normalized === 'fable-5' || normalized.startsWith('fable-5-') ? 'ultra' : undefined;
}

export function isUltraCredential(credential: CursorCredentialCapabilityView): boolean {
  return credential.plan === 'ultra';
}

export function credentialSupportsModel(
  credential: CursorCredentialCapabilityView,
  model: string | undefined,
): boolean {
  if (modelCredentialRequirement(model ?? '') !== 'ultra') return true;
  return isUltraCredential(credential) && credential.capabilities?.fable !== false;
}

export function credentialSelectionDecision(
  credential: CursorCredentialSelectionView,
  model: string | undefined,
  routingPolicy: CursorCredentialRoutingPolicy,
): CursorCredentialSelectionDecision {
  const requiresUltra = modelCredentialRequirement(model ?? '') === 'ultra';
  return {
    selectedCredentialId: credential.id,
    selectedPlan: credential.plan ?? 'unclassified',
    eligibility: requiresUltra ? 'fable_capable' : 'standard',
    routingPolicy,
    ultraReserveBypassed:
      routingPolicy === 'ultra_last' && !requiresUltra && isUltraCredential(credential),
  };
}
