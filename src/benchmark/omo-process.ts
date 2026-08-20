import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { StringDecoder } from 'node:string_decoder';
import {
  DEFAULT_OMO_STDERR_LIMIT_BYTES,
  DEFAULT_OMO_STDOUT_LIMIT_BYTES,
  OutputByteCounter,
} from './bounded-output.js';
import { commandOutput, inspectOmoComparator } from './comparator-inspection.js';
import { AuthStoreError } from './fixture-auth.js';
import { attachSessionSummary } from './omo-session.js';
import { isProcessTreeAlive, signalProcessTree } from './process-tree.js';
import {
  benchmarkEnvironment,
  createBenchmarkFixture,
  ModelStoreError,
  omoTrialArgs,
  redactBenchmarkText,
  redactBenchmarkValue,
  type BenchmarkFixture,
  type OmoJsonEvent,
} from './fixture.js';
import {
  OmoProcessError,
  type OmoProcessDependencies,
  type OmoTrialOptions,
  type OmoTrialResult,
  type TimedOmoEvent,
} from './omo-process-types.js';

export { OmoProcessError } from './omo-process-types.js';
export type {
  OmoProcessDependencies,
  OmoSpawn,
  OmoTrialOptions,
  OmoTrialResult,
  TimedOmoEvent,
} from './omo-process-types.js';

const COMPOSER_ID = 'composer-2.5';

function runChild(
  options: OmoTrialOptions,
  fixture: BenchmarkFixture,
  env: NodeJS.ProcessEnv,
  dependencies: OmoProcessDependencies,
): Promise<OmoTrialResult> {
  const spawnChild =
    dependencies.spawn ??
    ((command, args, spawnOptions) => spawn(command, [...args], spawnOptions));
  const signalTree = dependencies.signalProcessTree ?? signalProcessTree;
  const treeAlive = dependencies.isProcessTreeAlive ?? isProcessTreeAlive;
  const started = performance.now();
  const args = omoTrialArgs(options.provider, options.model, fixture, options.seed);
  const child = spawnChild(options.command, args, {
    cwd: fixture.cwd,
    env,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  return new Promise((resolve, reject) => {
    const events: TimedOmoEvent[] = [];
    const decoder = new StringDecoder('utf8');
    const stdoutBytes = new OutputByteCounter(
      dependencies.maxStdoutBytes ?? DEFAULT_OMO_STDOUT_LIMIT_BYTES,
    );
    const stderrBytes = new OutputByteCounter(
      dependencies.maxStderrBytes ?? DEFAULT_OMO_STDERR_LIMIT_BYTES,
    );
    const sensitive = [fixture.rootDir, ...fixture.redactions];
    let pending = '';
    let stderr = '';
    let closed = false;
    let finished = false;
    let stopError: OmoProcessError | undefined;
    let escalation: NodeJS.Timeout | undefined;
    let hardStop: NodeJS.Timeout | undefined;

    const finish = (error?: OmoProcessError, result?: OmoTrialResult) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      if (escalation) clearTimeout(escalation);
      if (hardStop) clearTimeout(hardStop);
      options.signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else if (result) resolve(result);
    };
    const requestStop = (error: OmoProcessError) => {
      if (stopError) return;
      stopError = error;
      if (closed) return;
      const grace = dependencies.terminationGraceMs ?? 1_000;
      escalation = setTimeout(() => {
        signalTree(child, 'SIGKILL');
        hardStop = setTimeout(
          () =>
            finish(new OmoProcessError('lingering_descendant', 'OMO process tree did not exit')),
          grace,
        );
      }, grace);
      signalTree(child, 'SIGTERM');
      if (closed && escalation) clearTimeout(escalation);
    };
    const parseLine = (line: string) => {
      if (!line.trim()) return;
      try {
        const parsed: unknown = JSON.parse(line) as unknown;
        if (
          parsed === null ||
          typeof parsed !== 'object' ||
          typeof Reflect.get(parsed, 'type') !== 'string'
        ) {
          throw new Error('event is not an object with a type');
        }
        // prettier-ignore
        const event = { atMs: performance.now() - started, value: redactBenchmarkValue(parsed, sensitive) as OmoJsonEvent };
        events.push(event);
        dependencies.onEvent?.(event);
      } catch {
        requestStop(new OmoProcessError('malformed_jsonl', 'OMO emitted malformed JSONL'));
      }
    };
    const onStdout = (chunk: Buffer | string) => {
      if (stopError) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (!stdoutBytes.accept(bytes)) {
        requestStop(
          new OmoProcessError('stdout_overflow', 'OMO stdout exceeded the retained byte limit'),
        );
        return;
      }
      pending += decoder.write(bytes);
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) parseLine(line.endsWith('\r') ? line.slice(0, -1) : line);
    };
    const onAbort = () => requestStop(new OmoProcessError('cancel_failed', 'OMO trial aborted'));
    const timeout = setTimeout(
      () =>
        requestStop(new OmoProcessError('timeout', `OMO trial exceeded ${options.timeoutMs}ms`)),
      options.timeoutMs,
    );

    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', (chunk: Buffer | string) => {
      if (stopError) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (!stderrBytes.accept(bytes)) {
        requestStop(
          new OmoProcessError('stderr_overflow', 'OMO stderr exceeded the retained byte limit'),
        );
        return;
      }
      stderr += bytes.toString('utf8');
    });
    child.once('error', () =>
      requestStop(new OmoProcessError('harness_failure', 'failed to launch OMO')),
    );
    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      closed = true;
      if (!stopError) {
        pending += decoder.end();
        if (pending) parseLine(pending.endsWith('\r') ? pending.slice(0, -1) : pending);
      }
      const childPid = child.pid;
      let lingering = childPid !== undefined && treeAlive(childPid);
      if (lingering) {
        signalTree(child, 'SIGKILL');
        lingering = childPid !== undefined && treeAlive(childPid);
      }
      const error =
        stopError ??
        (lingering
          ? new OmoProcessError('lingering_descendant', 'OMO process tree remained after cleanup')
          : undefined) ??
        (code !== 0 ||
        signal !== null ||
        !events.some((event) => event.value.type === 'message_end')
          ? new OmoProcessError('early_exit', 'OMO exited without a successful terminal event')
          : undefined);
      const result = {
        events,
        diagnostics: redactBenchmarkText(stderr, sensitive),
        exit: { code, signal },
        session: null,
        durationMs: performance.now() - started,
      };
      if (error) error.details = result;
      finish(error, result);
    });
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    else child.stdin?.end(options.prompt);
  });
}

export async function runOmoTrial(
  options: OmoTrialOptions,
  dependencies: OmoProcessDependencies = {},
): Promise<OmoTrialResult> {
  if (options.model !== COMPOSER_ID || !/^[A-Za-z0-9._-]{1,64}$/.test(options.seed)) {
    throw new OmoProcessError('missing_model', 'requires exact Composer id and valid seed');
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new OmoProcessError('harness_failure', 'benchmark timeout must be positive and bounded');
  }
  let fixture: BenchmarkFixture;
  try {
    fixture = await createBenchmarkFixture(options);
  } catch (error) {
    if (error instanceof ModelStoreError) {
      throw new OmoProcessError('missing_model', 'benchmark model store is missing or malformed');
    }
    if (error instanceof AuthStoreError) {
      throw new OmoProcessError('harness_failure', 'benchmark auth store is missing or malformed');
    }
    throw error;
  }
  try {
    const env = benchmarkEnvironment(fixture, options.seed);
    const inspection = await inspectOmoComparator(
      options.command,
      env,
      dependencies.commandOutput ?? commandOutput,
      options.timeoutMs,
      options.signal,
    );
    dependencies.onComparatorInspection?.(inspection);
    if (inspection.outcome === 'cancelled') {
      throw new OmoProcessError('cancel_failed', 'comparator preflight aborted');
    }
    if (inspection.outcome === 'timeout') {
      throw new OmoProcessError('timeout', `comparator preflight exceeded ${options.timeoutMs}ms`);
    }
    if (inspection.outcome) {
      throw new OmoProcessError(inspection.outcome, 'installed OMO comparator does not match pins');
    }
    try {
      const result = await runChild(options, fixture, env, dependencies);
      await attachSessionSummary(result, fixture.sessionDir);
      return result;
    } catch (error) {
      if (
        error instanceof OmoProcessError &&
        error.failureClass !== 'evidence_io_failure' &&
        error.details
      ) {
        await attachSessionSummary(error.details, fixture.sessionDir);
      }
      throw error;
    }
  } finally {
    await fixture.dispose();
  }
}
