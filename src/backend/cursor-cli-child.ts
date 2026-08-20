import type { SpawnOptions } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { CursorCommandAbortedError } from './cursor-cli-errors.js';

export type CursorChildSignal = NodeJS.Signals;

export interface CursorChildProcess {
  readonly pid?: number;
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  kill(signal?: number | CursorChildSignal): boolean;
  on(event: 'error', listener: (error: Error) => void): this;
  on(
    event: 'exit' | 'close',
    listener: (code: number | null, signal: CursorChildSignal | null) => void,
  ): this;
}

export type CursorSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => CursorChildProcess;

export type ManagedCursorCommand = {
  readonly terminate: (error: Error) => Promise<void>;
};

export class CursorChildRegistry {
  private readonly commands = new Set<ManagedCursorCommand>();

  add(command: ManagedCursorCommand): void {
    this.commands.add(command);
  }

  delete(command: ManagedCursorCommand): void {
    this.commands.delete(command);
  }

  async shutdown(): Promise<void> {
    const error = new CursorCommandAbortedError('cursor backend shutting down');
    await Promise.all([...this.commands].map((command) => command.terminate(error)));
  }

  get size(): number {
    return this.commands.size;
  }
}
