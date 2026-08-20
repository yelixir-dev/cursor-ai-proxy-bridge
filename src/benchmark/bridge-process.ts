import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { synchronizeChildTrace } from './bridge-ipc.js';
import { BridgeTraceCollector } from './bridge-trace.js';
export type { BridgeTraceScope, SanitizedBridgeTraceRecord, TraceState } from './bridge-trace.js';
import type { BridgeTraceScope, SanitizedBridgeTraceRecord, TraceState } from './bridge-trace.js';

export const BRIDGE_API_KEY = 'benchmark-local-not-a-secret';
const LISTEN_ANNOUNCEMENT = 'cursor-ai-bridge listening on';
const DEFAULT_START_DEADLINE_MS = 30_000;
const DEFAULT_STOP_DEADLINE_MS = 10_000;
export interface BridgeCleanupReceipt {
  benchmark_owned_pid: number | null;
  close_observed: boolean;
  exit_code: number | null;
  exit_signal: NodeJS.Signals | null;
}

export interface BridgeHandle {
  port: number;
  baseUrl: string;
  trace(): TraceState;
  traceRecords(): readonly SanitizedBridgeTraceRecord[];
  beginTraceScope(): BridgeTraceScope;
  cleanupReceipt(): BridgeCleanupReceipt;
  stop(): Promise<void>;
}

export type BridgeSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface BridgeProcessOptions {
  signal?: AbortSignal;
  spawnImpl?: BridgeSpawn;
  startDeadlineMs?: number;
  stopDeadlineMs?: number;
}

function deadlineTimer(ms: number, onExpire: () => void): NodeJS.Timeout {
  const timer = setTimeout(onExpire, ms);
  timer.unref?.();
  return timer;
}

function killChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill(signal);
  } catch {
    // Concurrent bridge exit is already the desired state.
  }
}

export async function allocateEphemeralPort(): Promise<number> {
  const socket = createServer();
  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      socket.once('error', rejectListen);
      socket.listen(0, '127.0.0.1', () => resolveListen());
    });
    const address = socket.address();
    if (address === null || typeof address === 'string') throw new Error('no ephemeral port');
    return address.port;
  } finally {
    await new Promise<void>((resolveClose) => socket.close(() => resolveClose()));
  }
}

export async function startBridge(
  entry: string,
  options: BridgeProcessOptions = {},
): Promise<BridgeHandle> {
  const port = await allocateEphemeralPort();
  const trace = new BridgeTraceCollector();
  const spawnChild =
    options.spawnImpl ?? ((command, args, spawnOptions) => spawn(command, [...args], spawnOptions));
  const bridgeChild = resolve(dirname(fileURLToPath(import.meta.url)), 'bridge-child.js');
  const child = spawnChild(process.execPath, [bridgeChild, entry], {
    env: {
      ...process.env,
      CURSOR_BRIDGE_HOST: '127.0.0.1',
      CURSOR_BRIDGE_PORT: String(port),
      CURSOR_BRIDGE_API_KEY: BRIDGE_API_KEY,
      CURSOR_BRIDGE_BACKEND: 'cursor-api',
      CURSOR_BRIDGE_AUTO_PROBE_TIMEOUT_MS:
        process.env.CURSOR_BENCH_BRIDGE_STARTUP_TIMEOUT_MS ?? '30000',
      CURSOR_BRIDGE_TRACE: '1',
      NO_COLOR: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let closeReceipt: BridgeCleanupReceipt = {
    benchmark_owned_pid: child.pid ?? null,
    close_observed: false,
    exit_code: null,
    exit_signal: null,
  };
  const closed = new Promise<BridgeCleanupReceipt>((resolveClose) =>
    child.once('close', (code, signal) => {
      closeReceipt = {
        ...closeReceipt,
        close_observed: true,
        exit_code: code,
        exit_signal: signal,
      };
      resolveClose(closeReceipt);
    }),
  );
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolveExit) => child.once('exit', (code, signal) => resolveExit({ code, signal })));
  const decoder = new StringDecoder('utf8');
  let pendingStderr = '';
  child.stderr?.on('data', (chunk: Buffer | string) => {
    if (typeof child.send === 'function') return;
    pendingStderr += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const lines = pendingStderr.split('\n');
    pendingStderr = lines.pop() ?? '';
    for (const line of lines) trace.ingest(line.endsWith('\r') ? line.slice(0, -1) : line);
  });
  child.stderr?.once('end', () => {
    if (typeof child.send === 'function') return;
    pendingStderr += decoder.end();
    if (pendingStderr) trace.ingest(pendingStderr);
    pendingStderr = '';
  });
  child.on('message', (message: unknown) => {
    if (message === null || typeof message !== 'object') return;
    if (Reflect.get(message, 'type') !== 'benchmark_trace_record') return;
    trace.ingestValue(Reflect.get(message, 'record'));
  });
  let barrierId = 0;
  let stopped = false;
  const killNow = (): void => {
    if (stopped) return;
    stopped = true;
    process.removeListener('exit', killNow);
    killChild(child, 'SIGKILL');
  };
  process.once('exit', killNow);
  const listening = new Promise<void>((resolveListen, rejectListen) => {
    const expire = deadlineTimer(options.startDeadlineMs ?? DEFAULT_START_DEADLINE_MS, () =>
      rejectListen(new Error('bridge listen deadline exceeded')),
    );
    const onAbort = (): void => {
      clearTimeout(expire);
      rejectListen(new Error('bridge start aborted'));
    };
    const cleanup = (): void => {
      clearTimeout(expire);
      options.signal?.removeEventListener('abort', onAbort);
    };
    let announced = '';
    child.stdout?.on('data', (chunk: Buffer | string) => {
      announced += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
      if (announced.includes(LISTEN_ANNOUNCEMENT)) {
        cleanup();
        resolveListen();
      }
    });
    child.once('error', (error) => {
      cleanup();
      rejectListen(new Error(`bridge failed to start: ${error.message}`));
    });
    exited.then(({ code, signal }) => {
      cleanup();
      rejectListen(new Error(`bridge exited before listening (code=${code}, signal=${signal})`));
    });
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener('abort', onAbort, { once: true });
  });
  await listening.catch(async (error: unknown) => {
    killNow();
    const expired = Symbol('expired');
    const outcome = await Promise.race([
      closed,
      new Promise<typeof expired>((resolveExpire) =>
        deadlineTimer(options.stopDeadlineMs ?? DEFAULT_STOP_DEADLINE_MS, () =>
          resolveExpire(expired),
        ),
      ),
    ]);
    if (outcome === expired) {
      killChild(child, 'SIGKILL');
      await closed;
    }
    throw error;
  });

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    trace: () => trace.snapshot(),
    traceRecords: () => trace.records(),
    beginTraceScope: () => {
      const scope = trace.beginScope();
      return {
        snapshot: scope.snapshot,
        waitForRunOpen: scope.waitForRunOpen,
        subscribeBackendChange: scope.subscribeBackendChange,
        // prettier-ignore
        waitForSynchronizedRunOpen: async (timeoutMs, signal) => (await scope.waitForRunOpen(timeoutMs, signal)) && (await synchronizeChildTrace(child, ++barrierId, timeoutMs, signal)) && scope.snapshot().runOpens > 0,
        async finish() {
          const synchronized = await synchronizeChildTrace(child, ++barrierId, 1_000);
          return scope.finish(synchronized);
        },
      };
    },
    cleanupReceipt: () => ({ ...closeReceipt }),
    async stop() {
      if (stopped) {
        if (!closeReceipt.close_observed) await closed;
        return;
      }
      stopped = true;
      process.removeListener('exit', killNow);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      const expired = Symbol('expired');
      const outcome = await Promise.race([
        closed,
        new Promise<typeof expired>((resolveExpire) =>
          deadlineTimer(options.stopDeadlineMs ?? DEFAULT_STOP_DEADLINE_MS, () =>
            resolveExpire(expired),
          ),
        ),
      ]);
      if (outcome === expired) killChild(child, 'SIGKILL');
      await closed;
    },
  };
}

export async function fetchHealth(
  baseUrl: string,
): Promise<{ ok: boolean; activeBackend: string; bridgeVersion: string }> {
  const response = await fetch(`${baseUrl}/health`, {
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await response.json()) as {
    status?: unknown;
    backend?: { ok?: unknown; activeBackend?: unknown; type?: unknown };
    bridge?: { version?: unknown };
  };
  const activeBackend =
    typeof body.backend?.activeBackend === 'string'
      ? body.backend.activeBackend
      : typeof body.backend?.type === 'string'
        ? body.backend.type
        : 'unknown';
  return {
    ok: response.status === 200 && body.status === 'ok' && body.backend?.ok !== false,
    activeBackend,
    bridgeVersion: typeof body.bridge?.version === 'string' ? body.bridge.version : 'unknown',
  };
}
