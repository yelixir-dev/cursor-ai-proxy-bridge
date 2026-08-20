import { execFile } from 'node:child_process';
import { redactBenchmarkText } from './fixture.js';

export const PINNED_OMO_VERSION = '5.0.0-0.beta.9';
export const PINNED_SENPI_VERSION = '2026.8.17';
export const PINNED_COMPARATOR_VERSION_STRING = `omo ${PINNED_OMO_VERSION} (engine: senpi ${PINNED_SENPI_VERSION})`;

export type CommandOutput = (
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
) => Promise<string>;

export interface OmoComparatorInspection {
  readonly outcome: 'harness_version_mismatch' | 'missing_model' | 'timeout' | 'cancelled' | null;
  readonly observedVersionString: string | null;
  readonly observedOmoVersion: string | null;
  readonly observedSenpiVersion: string | null;
  readonly modelObserved: boolean;
}

export function commandOutput(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    execFile(
      command,
      [...args],
      { env, signal, encoding: 'utf8', maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) reject(error);
        else resolveOutput(stdout);
      },
    );
  });
}

function emptyInspection(
  outcome: Exclude<OmoComparatorInspection['outcome'], null>,
): OmoComparatorInspection {
  return {
    outcome,
    observedVersionString: null,
    observedOmoVersion: null,
    observedSenpiVersion: null,
    modelObserved: false,
  };
}

export async function inspectOmoComparator(
  command: string,
  env: NodeJS.ProcessEnv,
  output: CommandOutput,
  timeoutMs: number,
  external?: AbortSignal,
): Promise<OmoComparatorInspection> {
  const controller = new AbortController();
  let stop: ((inspection: OmoComparatorInspection) => void) | undefined;
  const stopped = new Promise<OmoComparatorInspection>((resolveStopped) => {
    stop = resolveStopped;
  });
  const halt = (outcome: 'timeout' | 'cancelled') => {
    stop?.(emptyInspection(outcome));
    controller.abort();
  };
  const forwardAbort = () => halt('cancelled');
  const timer = setTimeout(() => halt('timeout'), timeoutMs);
  if (external?.aborted) halt('cancelled');
  else external?.addEventListener('abort', forwardAbort, { once: true });
  const inspection = (async (): Promise<OmoComparatorInspection> => {
    try {
      const [versionOutput, models] = await Promise.all([
        output(command, ['--version'], env, controller.signal),
        output(command, ['--offline', '--list-models', 'composer-2.5'], env, controller.signal),
      ]);
      const observedVersionString = redactBenchmarkText(versionOutput.trim(), []).slice(0, 256);
      const parsed = /^omo (\S+) \(engine: senpi (\S+)\)$/.exec(observedVersionString);
      const modelObserved = models
        .split(/\r?\n/)
        .map((line) => line.trim().split(/\s+/))
        .some((columns) => columns[0] === 'cursor' && columns[1] === 'composer-2.5');
      return {
        outcome:
          observedVersionString !== PINNED_COMPARATOR_VERSION_STRING
            ? 'harness_version_mismatch'
            : modelObserved
              ? null
              : 'missing_model',
        observedVersionString,
        observedOmoVersion: parsed?.[1] ?? null,
        observedSenpiVersion: parsed?.[2] ?? null,
        modelObserved,
      };
    } catch (error) {
      controller.abort();
      if (error instanceof Error) return emptyInspection('harness_version_mismatch');
      throw error;
    }
  })();
  try {
    return await Promise.race([inspection, stopped]);
  } finally {
    clearTimeout(timer);
    external?.removeEventListener('abort', forwardAbort);
    controller.abort();
  }
}
