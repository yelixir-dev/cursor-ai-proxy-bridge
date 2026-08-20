import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

export type RequestAbort = {
  readonly signal: AbortSignal;
  readonly cleanup: () => void;
};

export function requestAbortSignal(request: FastifyRequest, reply: FastifyReply): RequestAbort {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  const requestClosed = (): void => {
    if (request.raw.aborted || !request.raw.complete) abort();
  };
  const responseClosed = (): void => {
    if (!reply.raw.writableEnded) abort();
  };
  request.raw.once('aborted', abort);
  request.raw.once('close', requestClosed);
  reply.raw.once('close', responseClosed);
  return {
    signal: controller.signal,
    cleanup: () => {
      request.raw.removeListener('aborted', abort);
      request.raw.removeListener('close', requestClosed);
      reply.raw.removeListener('close', responseClosed);
    },
  };
}

export class CompletionLimiter {
  private globalInFlight = 0;
  private readonly perKeyInFlight = new Map<string, number>();

  constructor(
    private readonly globalLimit: number,
    private readonly perKeyLimit: number,
  ) {}

  acquire(apiKey: string): (() => void) | undefined {
    const keyId = createHash('sha256').update(apiKey).digest('hex');
    const keyInFlight = this.perKeyInFlight.get(keyId) ?? 0;
    if (this.globalInFlight >= this.globalLimit || keyInFlight >= this.perKeyLimit) {
      return undefined;
    }
    this.globalInFlight += 1;
    this.perKeyInFlight.set(keyId, keyInFlight + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.globalInFlight = Math.max(0, this.globalInFlight - 1);
      const remaining = Math.max(0, (this.perKeyInFlight.get(keyId) ?? 1) - 1);
      if (remaining === 0) this.perKeyInFlight.delete(keyId);
      else this.perKeyInFlight.set(keyId, remaining);
    };
  }
}
