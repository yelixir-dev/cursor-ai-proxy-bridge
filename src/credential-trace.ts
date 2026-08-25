import { credentialSlotId, type RequestTrace, traceStage } from './trace.js';
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
