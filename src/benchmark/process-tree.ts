import type { ChildProcess } from 'node:child_process';

export function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The group may have exited between the lifecycle event and this signal.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Concurrent process exit is already the desired state.
  }
}

export function isProcessTreeAlive(pid: number): boolean {
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, 0);
    return true;
  } catch (error: unknown) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH');
  }
}
