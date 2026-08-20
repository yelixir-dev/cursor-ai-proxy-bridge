import type { FailureClass } from './types.js';

const AUTH_SIGNATURE =
  /authentication_error|unauthorized|invalid[ _-]?api[ _-]?key|missing or invalid|\b401\b/i;

export interface ChildFailureInput {
  erroredAssistantTurns: number;
  assistantErrorText: string;
  diagnostics: string;
}

export function childReportFailure(input: ChildFailureInput): FailureClass | null {
  const signature =
    AUTH_SIGNATURE.test(input.assistantErrorText) || AUTH_SIGNATURE.test(input.diagnostics);
  if (input.erroredAssistantTurns > 0) return signature ? 'auth' : 'transport';
  return signature ? 'auth' : null;
}
