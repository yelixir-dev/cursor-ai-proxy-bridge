import { statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { BridgeConfig } from '../config.js';
import { CursorCommandAbortedError } from './cursor-cli-errors.js';

export type CursorWorkspace = {
  readonly cwd: string;
  readonly cleanup: () => Promise<void>;
};

export async function createCursorWorkspace(config: BridgeConfig): Promise<CursorWorkspace> {
  if (config.workspaceMode === 'real-workspace') {
    if (!config.realWorkspacePath) {
      throw new Error('CURSOR_BRIDGE_REAL_WORKSPACE is required for real-workspace mode');
    }
    const cwd = resolve(config.realWorkspacePath);
    const info = statSync(cwd);
    if (!info.isDirectory()) throw new Error(`real workspace is not a directory: ${cwd}`);
    return { cwd, cleanup: async () => undefined };
  }
  const cwd = await mkdtemp(join(tmpdir(), 'cursor-ai-bridge-'));
  return { cwd, cleanup: async () => rm(cwd, { recursive: true, force: true }) };
}

type WorkspaceWaiter = {
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: Error) => void;
  readonly signal?: AbortSignal;
  onAbort?: () => void;
};

class WorkspaceMutex {
  private held = false;
  private readonly waiters: WorkspaceWaiter[] = [];

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new CursorCommandAbortedError();
    if (!this.held) {
      this.held = true;
      return this.releaseFunction();
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: WorkspaceWaiter = { resolve, reject, signal };
      waiter.onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new CursorCommandAbortedError());
      };
      signal?.addEventListener('abort', waiter.onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  get idle(): boolean {
    return !this.held && this.waiters.length === 0;
  }

  private releaseFunction(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) {
        if (next.onAbort) next.signal?.removeEventListener('abort', next.onAbort);
        next.resolve(this.releaseFunction());
      } else {
        this.held = false;
      }
    };
  }
}

const workspaceMutexes = new Map<string, WorkspaceMutex>();

export async function acquireWorkspaceMutex(
  path: string,
  signal?: AbortSignal,
): Promise<() => void> {
  let mutex = workspaceMutexes.get(path);
  if (!mutex) {
    mutex = new WorkspaceMutex();
    workspaceMutexes.set(path, mutex);
  }
  try {
    const release = await mutex.acquire(signal);
    return () => {
      release();
      if (mutex.idle) workspaceMutexes.delete(path);
    };
  } catch (error) {
    if (mutex.idle) workspaceMutexes.delete(path);
    throw error;
  }
}
