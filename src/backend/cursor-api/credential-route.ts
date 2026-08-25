import { traceCredentialFailover } from '../../credential-trace.js';
import { traceCredentialSlot, type RequestTrace } from '../../trace.js';
import type { CursorApiCredential } from './credentials.js';
import type { CursorApiRuntime } from './runtime.js';

export interface CursorCredentialOperation<T> {
  readonly operation: (credential: CursorApiCredential, accessToken: string) => Promise<T>;
  readonly signal?: AbortSignal;
  readonly trace?: RequestTrace;
  readonly canFailover?: () => boolean;
  readonly preferredCredentialId?: string;
}

export function withCursorCredential<T>(
  runtime: CursorApiRuntime,
  options: CursorCredentialOperation<T>,
): Promise<T> {
  return runtime.credentialRouter.route(
    async (credential) => {
      traceCredentialSlot(options.trace, credential.id);
      return options.operation(credential, await runtime.auth.getToken(credential, options.signal));
    },
    {
      ...(options.canFailover === undefined ? {} : { canFailover: options.canFailover }),
      ...(options.preferredCredentialId === undefined
        ? {}
        : { preferredCredentialId: options.preferredCredentialId }),
      onFailover: (decision) =>
        traceCredentialFailover(
          options.trace,
          decision.excludedCredentialId,
          decision.reason,
          decision.nextCredentialId,
        ),
    },
  );
}
