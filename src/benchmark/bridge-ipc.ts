import type { ChildProcess } from 'node:child_process';

export function synchronizeChildTrace(
  child: Pick<ChildProcess, 'connected' | 'send' | 'on' | 'once' | 'removeListener'>,
  id: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  if (typeof child.send !== 'function' || child.connected === false) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const finish = (synchronized: boolean): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      child.removeListener('message', onMessage);
      child.removeListener('close', onClose);
      resolve(synchronized);
    };
    const onAbort = (): void => finish(false);
    const onClose = (): void => finish(false);
    const onMessage = (message: unknown): void => {
      if (
        message !== null &&
        typeof message === 'object' &&
        Reflect.get(message, 'type') === 'benchmark_trace_barrier_done' &&
        Reflect.get(message, 'id') === id
      ) {
        finish(true);
      }
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    child.on('message', onMessage);
    child.once('close', onClose);
    if (signal?.aborted) onAbort();
    else {
      signal?.addEventListener('abort', onAbort, { once: true });
      child.send({ type: 'benchmark_trace_barrier', id }, (error) => {
        if (error) finish(false);
      });
    }
  });
}
