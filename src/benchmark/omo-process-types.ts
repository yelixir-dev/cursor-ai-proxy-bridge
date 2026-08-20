import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type { SessionTranscriptSummary } from './child-trace.js';
import type { CommandOutput, OmoComparatorInspection } from './comparator-inspection.js';
import type { BenchmarkFixtureOptions, OmoJsonEvent } from './fixture.js';
import type { FailureClass } from './types.js';

export type OmoSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface OmoTrialOptions extends BenchmarkFixtureOptions {
  readonly provider: string;
  readonly model: string;
  readonly prompt: string;
  readonly seed: string;
  readonly timeoutMs: number;
  readonly command: string;
  readonly signal?: AbortSignal;
}

export interface TimedOmoEvent {
  atMs: number;
  value: OmoJsonEvent;
}

export interface OmoTrialResult {
  events: TimedOmoEvent[];
  diagnostics: string;
  exit: { code: number | null; signal: NodeJS.Signals | null };
  session: SessionTranscriptSummary | null;
  durationMs: number;
}

export class OmoProcessError extends Error {
  details?: OmoTrialResult;

  constructor(
    readonly failureClass: FailureClass,
    message: string,
    options: { readonly cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'OmoProcessError';
  }
}

export interface OmoProcessDependencies {
  readonly spawn?: OmoSpawn;
  readonly commandOutput?: CommandOutput;
  readonly terminationGraceMs?: number;
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
  readonly signalProcessTree?: (child: ChildProcess, signal: NodeJS.Signals) => void;
  readonly isProcessTreeAlive?: (pid: number) => boolean;
  readonly onEvent?: (event: TimedOmoEvent) => void;
  readonly onComparatorInspection?: (inspection: OmoComparatorInspection) => void;
}
