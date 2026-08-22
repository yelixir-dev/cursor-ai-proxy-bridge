import { CursorBackendError } from '../cursor-cli.js';
import type { CursorRunTransportDiagnostics } from './transport.js';

export interface CursorRunTimeoutDiagnostics {
  readonly lastInteractionCase: string | null;
  readonly lastInteractionAgoMs: number;
  readonly outputBytes: number;
  readonly sawTurnEnded: boolean;
  readonly sawTrailer: boolean;
  readonly transport: CursorRunTransportDiagnostics;
}

export class CursorRunTimeoutError extends CursorBackendError {
  readonly name = 'CursorRunTimeoutError';
  readonly code = 'ERR_CURSOR_RUN_TIMEOUT';

  constructor(
    message: string,
    readonly runRequestId: string,
    readonly diagnostics: CursorRunTimeoutDiagnostics,
  ) {
    super(message);
  }
}

export function cursorRunRequestId(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const requestId = Reflect.get(error, 'runRequestId');
  return typeof requestId === 'string' && requestId.length > 0 ? requestId : undefined;
}

export function cursorRunDiagnostics(error: unknown): CursorRunTimeoutDiagnostics | undefined {
  if (!(error instanceof CursorRunTimeoutError)) return undefined;
  return error.diagnostics;
}
