import { createHash } from 'node:crypto';
import type { RequestTrace } from './trace.js';

export function credentialSlotId(credentialId: string): string {
  const digest = createHash('sha256').update(credentialId).digest('hex').slice(0, 16);
  return `slot_${digest}`;
}

export function traceCredentialSlot(trace: RequestTrace | undefined, credentialId: string): void {
  if (trace) trace.credentialSlotId = credentialSlotId(credentialId);
}
