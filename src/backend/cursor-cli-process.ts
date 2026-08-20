import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import {
  CursorChildRegistry,
  type CursorChildProcess,
  type CursorChildSignal,
  type CursorSpawn,
  type ManagedCursorCommand,
} from './cursor-cli-child.js';
import { childEnvironment } from './cursor-cli-environment.js';
import { CursorBackendError, CursorCommandAbortedError } from './cursor-cli-errors.js';

const DEFAULT_TERMINATION_GRACE_MS = 750;
const DEFAULT_MAX_OUTPUT_BYTES = 8_388_608;

export type CursorCommandRunner = (
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  stdinContent?: string,
  signal?: AbortSignal,
  onStdout?: (chunk: string) => void,
) => Promise<string>;

function signalProcessGroup(child: CursorChildProcess, signal: CursorChildSignal): void {
  if (process.platform !== 'win32' && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // A test double or a child that exited between checks may not have a process group.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // A concurrent exit makes termination a no-op.
  }
}

export type CursorCommandRunnerOptions = {
  readonly registry?: CursorChildRegistry;
  readonly spawn?: CursorSpawn;
  readonly env?: NodeJS.ProcessEnv;
  readonly terminationGraceMs?: number;
  readonly maxOutputBytes?: number;
  readonly signalChild?: (child: CursorChildProcess, signal: CursorChildSignal) => void;
};

type IntegerBounds = {
  readonly fallback: number;
  readonly minimum: number;
  readonly maximum: number;
};

function boundedInteger(raw: string | undefined, bounds: IntegerBounds): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed >= bounds.minimum && parsed <= bounds.maximum
    ? parsed
    : bounds.fallback;
}

export function createCursorCommandRunner(
  options: CursorCommandRunnerOptions = {},
): CursorCommandRunner {
  const registry = options.registry ?? new CursorChildRegistry();
  const spawnCommand = options.spawn ?? spawn;
  const env = childEnvironment(options.env);
  const terminationGraceMs =
    options.terminationGraceMs ??
    boundedInteger(
      options.env?.CURSOR_BRIDGE_TERMINATION_GRACE_MS ??
        process.env.CURSOR_BRIDGE_TERMINATION_GRACE_MS,
      { fallback: DEFAULT_TERMINATION_GRACE_MS, minimum: 1, maximum: 30_000 },
    );
  const maxOutputBytes =
    options.maxOutputBytes ??
    boundedInteger(
      options.env?.CURSOR_BRIDGE_MAX_OUTPUT_BYTES ?? process.env.CURSOR_BRIDGE_MAX_OUTPUT_BYTES,
      { fallback: DEFAULT_MAX_OUTPUT_BYTES, minimum: 1, maximum: 1_073_741_824 },
    );
  const sendSignal = options.signalChild ?? signalProcessGroup;

  return (command, args, cwd, timeoutMs, stdinContent, signal, onStdout) =>
    new Promise((resolveOutput, reject) => {
      if (signal?.aborted) {
        reject(new CursorCommandAbortedError());
        return;
      }

      let child: CursorChildProcess;
      try {
        child = spawnCommand(command, args, {
          cwd,
          detached: process.platform !== 'win32',
          env,
          stdio: stdinContent === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
        });
      } catch (error) {
        reject(error);
        return;
      }

      let finished = false;
      let exited = false;
      let stdout = '';
      let stderr = '';
      let outputBytes = 0;
      const stdoutDecoder = new StringDecoder('utf8');
      let stdoutFinalized = false;
      let termination: Promise<void> | undefined;
      let resolveExit: (() => void) | undefined;
      const exitPromise = new Promise<void>((resolve) => {
        resolveExit = resolve;
      });

      const finish = (error?: Error, output?: string) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        registry.delete(managed);
        if (error) reject(error);
        else resolveOutput(output ?? '');
      };
      const noteExit = () => {
        if (exited) return;
        exited = true;
        resolveExit?.();
        registry.delete(managed);
      };
      const waitForGraceOrExit = async () => {
        if (exited) return;
        let graceTimer: NodeJS.Timeout | undefined;
        await Promise.race([
          exitPromise,
          new Promise<void>((resolve) => {
            graceTimer = setTimeout(resolve, terminationGraceMs);
          }),
        ]);
        if (graceTimer) clearTimeout(graceTimer);
      };
      const terminate = (error: Error): Promise<void> => {
        if (termination) return termination;
        clearTimeout(timeout);
        termination = (async () => {
          sendSignal(child, 'SIGTERM');
          await waitForGraceOrExit();
          if (!exited) {
            sendSignal(child, 'SIGKILL');
            await exitPromise;
          }
          finish(error);
        })();
        return termination;
      };
      const managed: ManagedCursorCommand = { terminate };
      const onAbort = () => void terminate(new CursorCommandAbortedError());
      const timeout = setTimeout(() => {
        void terminate(new Error(`cursor command timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const capture = (target: 'stdout' | 'stderr', chunk: Buffer | string) => {
        if (termination) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        outputBytes += buffer.byteLength;
        if (outputBytes > maxOutputBytes) {
          void terminate(new CursorBackendError('output limit exceeded'));
          return;
        }
        if (target === 'stdout') {
          const decoded = stdoutDecoder.write(buffer);
          stdout += decoded;
          if (decoded) onStdout?.(decoded);
        } else stderr += buffer.toString('utf8');
      };
      const finalizeStdout = () => {
        if (stdoutFinalized) return;
        stdoutFinalized = true;
        const decoded = stdoutDecoder.end();
        stdout += decoded;
        if (decoded) onStdout?.(decoded);
      };

      registry.add(managed);
      child.stdout?.on('data', (chunk: Buffer | string) => capture('stdout', chunk));
      child.stderr?.on('data', (chunk: Buffer | string) => capture('stderr', chunk));
      child.on('error', (error) => {
        noteExit();
        if (!termination) finish(error);
      });
      child.on('exit', noteExit);
      child.on('close', (code) => {
        noteExit();
        finalizeStdout();
        if (termination) return;
        if (code === 0) finish(undefined, stdout.trim());
        else finish(new Error(stderr.trim() || `cursor exited with code ${code ?? 'unknown'}`));
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();

      if (stdinContent !== undefined && child.stdin) {
        child.stdin.write(stdinContent, 'utf8');
        child.stdin.end();
      }
    });
}
