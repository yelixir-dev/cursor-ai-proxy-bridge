import type { CursorCredentialSelectionDecision } from './backend/cursor-api/credential-plan.js';
import { type RequestTrace, traceStage } from './trace.js';
import { credentialSlotId } from './trace-credential-slot.js';
import type { TraceCredentialExclusionReason } from './trace-contract.js';

export function traceCredentialFailover(
  trace: RequestTrace | undefined,
  excludedCredentialId: string,
  reason: TraceCredentialExclusionReason,
  nextCredentialId: string,
): void {
  traceStage(trace, 'credential_failover', {
    excludedCredentialSlotId: credentialSlotId(excludedCredentialId),
    credentialExclusionReason: reason,
    nextCredentialSlotId: credentialSlotId(nextCredentialId),
  });
}

export function traceCredentialSelection(
  trace: RequestTrace | undefined,
  decision: CursorCredentialSelectionDecision,
): void {
  if (!trace) return;
  trace.credentialSlotId = credentialSlotId(decision.selectedCredentialId);
  traceStage(trace, 'credential_route', {
    credentialPlan: decision.selectedPlan,
    credentialEligibility: decision.eligibility,
    routingPolicy: decision.routingPolicy,
    ultraReserveBypassed: decision.ultraReserveBypassed,
  });
}
