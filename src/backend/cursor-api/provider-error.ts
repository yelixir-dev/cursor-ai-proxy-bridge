import { ConnectRpcError } from './connect-frame.js';
import {
  decodeProviderErrorValue,
  type DecodedProviderErrorDetail,
} from './provider-error-protobuf.js';
import { CursorApiHttpError } from './transport.js';

const ERROR_DETAILS_TYPE = 'aiserver.v1.ErrorDetails';
const ERROR_PROVIDER_ERROR = 'ERROR_PROVIDER_ERROR';
const MAX_CAUSE_DEPTH = 10;

type ParsedDetail = DecodedProviderErrorDetail;

export interface ProviderInspection {
  readonly diagnostics?: CursorProviderErrorDiagnostics;
  readonly connectError: boolean;
  readonly providerError: boolean;
  readonly retryProvider5xx: boolean;
  readonly providerRetryableConflict: boolean;
  readonly nonProviderNonRetryable: boolean;
}

export interface CursorProviderErrorDiagnostics {
  readonly connectCode?: string;
  readonly upstreamErrorType?: string;
  readonly upstreamRetryable?: boolean;
  readonly providerStatusCode?: string;
  readonly runRequestId?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function cursorInferenceErrorType(value: unknown): string | undefined {
  return typeof value === 'string' && /^ERROR_[A-Z0-9_]{1,80}$/u.test(value) ? value : undefined;
}

function providerStatus(value: unknown): string | undefined {
  return typeof value === 'string' && /^[1-5][0-9]{2}$/u.test(value) ? value : undefined;
}

function connectCode(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/u.test(value) ? value : undefined;
}

function parseDebugDetail(detail: Record<string, unknown>): ParsedDetail | undefined {
  const debug = record(detail.debug);
  if (!debug) return undefined;
  const parsedErrorType = cursorInferenceErrorType(debug.error);
  if (Object.hasOwn(debug, 'error') && parsedErrorType === undefined) return undefined;
  const custom = record(debug.details);
  const additionalInfo = record(custom?.additionalInfo);
  return {
    ...(parsedErrorType === undefined ? {} : { errorType: parsedErrorType }),
    ...(typeof custom?.isRetryable === 'boolean' ? { retryable: custom.isRetryable } : {}),
    ...(providerStatus(additionalInfo?.providerStatusCode) === undefined
      ? {}
      : { providerStatusCode: providerStatus(additionalInfo?.providerStatusCode) }),
  };
}

function inspectDetails(error: ConnectRpcError): ProviderInspection {
  const details = Array.isArray(error.details) ? error.details : [];
  const headerProviderError = error.inferenceErrorType === ERROR_PROVIDER_ERROR;
  let providerError = headerProviderError;
  let providerDetail = false;
  let permanentDetail = false;
  let nonProviderNonRetryable = false;
  let retryable: boolean | undefined;
  let status: string | undefined;
  let statusConflict = false;
  let retryProvider5xx = false;
  let providerRetryableConflict = false;
  for (const candidate of details) {
    const detail = record(candidate);
    if (detail?.type !== ERROR_DETAILS_TYPE) continue;
    const parsed =
      typeof detail.value === 'string'
        ? decodeProviderErrorValue(detail.value)
        : parseDebugDetail(detail);
    if (!parsed) {
      nonProviderNonRetryable = true;
      continue;
    }
    const directProvider = parsed.errorType === ERROR_PROVIDER_ERROR;
    providerDetail ||= directProvider;
    const isProvider =
      directProvider ||
      (parsed.errorType === undefined && parsed.errorNumber === undefined && headerProviderError);
    providerError ||= isProvider;
    if (parsed.permanent) {
      permanentDetail = true;
      nonProviderNonRetryable = true;
    }
    if (parsed.retryable === false && !isProvider) nonProviderNonRetryable = true;
    if (isProvider) {
      if (parsed.retryable === false && parsed.providerStatusCode?.startsWith('5')) {
        retryProvider5xx = true;
      }
      if (parsed.retryable !== undefined) {
        if (retryable !== undefined && retryable !== parsed.retryable) {
          providerRetryableConflict = true;
        } else if (retryable === undefined) {
          retryable = parsed.retryable;
        }
      }
      if (parsed.providerStatusCode !== undefined) {
        if (status !== undefined && status !== parsed.providerStatusCode) {
          status = undefined;
          statusConflict = true;
        } else if (!statusConflict) {
          status = parsed.providerStatusCode;
        }
      }
    }
  }
  const headerErrorType = cursorInferenceErrorType(error.inferenceErrorType);
  const upstreamErrorType = permanentDetail
    ? undefined
    : providerDetail
      ? ERROR_PROVIDER_ERROR
      : (headerErrorType ?? (providerError ? ERROR_PROVIDER_ERROR : undefined));
  if (permanentDetail || providerRetryableConflict) {
    retryable = undefined;
    if (permanentDetail) status = undefined;
  }
  const diagnostics: CursorProviderErrorDiagnostics = {
    ...(connectCode(error.code) === undefined ? {} : { connectCode: connectCode(error.code) }),
    ...(upstreamErrorType === undefined ? {} : { upstreamErrorType }),
    ...(retryable === undefined ? {} : { upstreamRetryable: retryable }),
    ...(status === undefined ? {} : { providerStatusCode: status }),
    ...(typeof error.runRequestId === 'string' && error.runRequestId.length <= 96
      ? { runRequestId: error.runRequestId }
      : {}),
  };
  return {
    diagnostics: Object.keys(diagnostics).length === 0 ? undefined : diagnostics,
    connectError: true,
    providerError,
    retryProvider5xx: retryProvider5xx && !statusConflict && !providerRetryableConflict,
    providerRetryableConflict,
    nonProviderNonRetryable,
  };
}

export function inspectCursorProviderError(error: unknown): ProviderInspection {
  let current = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== undefined; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    if (current instanceof CursorApiHttpError) {
      const upstreamErrorType = cursorInferenceErrorType(current.inferenceErrorType);
      return {
        diagnostics:
          upstreamErrorType === undefined
            ? undefined
            : {
                upstreamErrorType,
                providerStatusCode: String(current.status),
                ...(current.runRequestId === undefined
                  ? {}
                  : { runRequestId: current.runRequestId }),
              },
        providerError: upstreamErrorType === ERROR_PROVIDER_ERROR,
        connectError: false,
        retryProvider5xx: false,
        providerRetryableConflict: false,
        nonProviderNonRetryable: false,
      };
    }
    if (current instanceof ConnectRpcError) return inspectDetails(current);
    current = record(current)?.cause;
  }
  return {
    connectError: false,
    providerError: false,
    retryProvider5xx: false,
    providerRetryableConflict: false,
    nonProviderNonRetryable: false,
  };
}

export function cursorProviderErrorDiagnostics(
  error: unknown,
): CursorProviderErrorDiagnostics | undefined {
  const diagnostics = inspectCursorProviderError(error).diagnostics;
  let current = error;
  const seen = new Set<unknown>();
  let runRequestId = diagnostics?.runRequestId;
  for (
    let depth = 0;
    runRequestId === undefined && depth < MAX_CAUSE_DEPTH && current !== undefined;
    depth += 1
  ) {
    if (seen.has(current)) break;
    seen.add(current);
    const value = record(current);
    const candidate = value?.runRequestId;
    if (typeof candidate === 'string' && candidate.length > 0 && candidate.length <= 96) {
      runRequestId = candidate;
      break;
    }
    current = value?.cause;
  }
  if (!diagnostics && runRequestId === undefined) return undefined;
  return {
    ...(diagnostics ?? {}),
    ...(runRequestId === undefined ? {} : { runRequestId }),
  };
}

export function safeCursorBackendError(error: unknown): Record<string, unknown> {
  const inspection = inspectCursorProviderError(error);
  const diagnostics = cursorProviderErrorDiagnostics(error);
  if (inspection.connectError || diagnostics?.upstreamErrorType !== undefined) {
    return {
      type: error instanceof Error ? error.name : typeof error,
      message: 'Cursor upstream provider error',
      ...diagnostics,
    };
  }
  if (!(error instanceof Error)) {
    return { type: typeof error, message: String(error), ...(diagnostics ?? {}) };
  }
  return {
    type: error.name,
    message: error.message,
    ...(error.stack === undefined ? {} : { stack: error.stack }),
    ...(diagnostics ?? {}),
  };
}

export function cursorProviderResponseDetails(
  error: unknown,
): Record<string, string | boolean> | undefined {
  const diagnostics = cursorProviderErrorDiagnostics(error);
  if (!diagnostics?.upstreamErrorType) return undefined;
  return {
    ...(diagnostics.connectCode === undefined ? {} : { connect_code: diagnostics.connectCode }),
    upstream_error_type: diagnostics.upstreamErrorType,
    ...(diagnostics.upstreamRetryable === undefined
      ? {}
      : { upstream_retryable: diagnostics.upstreamRetryable }),
    ...(diagnostics.providerStatusCode === undefined
      ? {}
      : { provider_status_code: diagnostics.providerStatusCode }),
  };
}
