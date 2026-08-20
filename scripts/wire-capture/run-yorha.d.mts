import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type { GeneratedCerts } from './gen-certs.d.mts';

export type YorhaCaseId =
  | 'tool_parallel_two'
  | 'tool_sequential_two_round'
  | 'cancel_after_first_event';

export type YorhaOutcome =
  | 'dry_run'
  | 'completed'
  | 'stalled'
  | 'probe_failed'
  | 'incomplete_capture'
  | 'boot_failed';

export interface YorhaCliArgs {
  case: YorhaCaseId;
  dryRun: boolean;
  captureDir?: string;
  portA: number;
  portB: number;
  bridgePort: number;
  targetA: string;
  targetB: string;
  omoBin?: string;
  timeoutMs: number;
  probeTimeoutMs: number;
  bootTimeoutMs: number;
  maxReqBins: number;
  maxResBins: number;
}

export interface YorhaPlan {
  caseId: YorhaCaseId;
  lane: 'yorha';
  seed: number;
  pairIndex: number;
  sentinel: string;
  prompt: string;
  omoSeed: string;
  projectRoot: string;
  captureDir: string;
  certsDir: string;
  api2CaptureDir: string;
  agentnCaptureDir: string;
  portA: number;
  portB: number;
  bridgePort: number;
  targetA: string;
  targetB: string;
  apiEndpoint: string;
  agentEndpoint: string;
  nodeExtraCaCerts: string;
  genCertsArgs: string[];
  proxyAArgs: string[];
  proxyBArgs: string[];
  bridgeCommand: string;
  bridgeArgs: string[];
  bridgeEnvNames: string[];
  omoBin: string;
  omoArgs: string[];
  probeUrl: string;
  timeoutMs: number;
  probeTimeoutMs: number;
  bootTimeoutMs: number;
}

export interface CaptureDirSummary {
  files: string[];
  bytes: number;
  complete: boolean;
}

export interface CaptureCompleteness {
  api2: CaptureDirSummary;
  agentn: CaptureDirSummary;
  complete: boolean;
  gaps: string[];
}

export interface YorhaReceipt {
  schema_version: 1;
  lane: 'yorha';
  case_id: YorhaCaseId;
  sentinel: string;
  ports: { api2: number; agentn: number; bridge: number };
  probe: { ok: boolean; status: number | null; error: string | null };
  captures: {
    api2: { files: string[]; bytes: number };
    agentn: { files: string[]; bytes: number };
  };
  outcome: YorhaOutcome;
  stall: boolean;
  error: string | null;
  omo_exit: { code: number | null; signal: string | null } | null;
  omo_diagnostics: {
    stdout_bytes: number;
    stderr_bytes: number;
    first_visible_event: boolean;
  } | null;
}

export interface YorhaRunResult {
  exitCode: number;
  outcome: YorhaOutcome;
  receipt: YorhaReceipt;
  plan: YorhaPlan;
  stdout: string;
}

export type YorhaSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface YorhaDependencies {
  spawn?: YorhaSpawn;
  generateCerts?: (options: { out: string; days?: number }) => GeneratedCerts;
  probeBridge?: (options: {
    baseUrl: string;
    apiKey: string;
    timeoutMs: number;
  }) => Promise<{ status: number }>;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  mkdir?: (typeof import('node:fs'))['mkdirSync'];
  writeFile?: (typeof import('node:fs'))['writeFileSync'];
  readFile?: (typeof import('node:fs'))['readFileSync'];
  exists?: (typeof import('node:fs'))['existsSync'];
  readdir?: (typeof import('node:fs'))['readdirSync'];
  stat?: (typeof import('node:fs'))['statSync'];
  rm?: (typeof import('node:fs'))['rmSync'];
  mkdtemp?: (typeof import('node:fs'))['mkdtempSync'];
}

export declare const SEED: 20260818;
export declare const LANE: 'yorha';
export declare const CASE_IDS: readonly YorhaCaseId[];
export declare const DEFAULT_PORT_A: 28443;
export declare const DEFAULT_PORT_B: 28444;
export declare const DEFAULT_BRIDGE_PORT: 9998;
export declare const DEFAULT_MAX_REQ_BINS: 200;
export declare const DEFAULT_MAX_RES_BINS: 500;

export declare function parseArgs(argv: readonly string[]): YorhaCliArgs;
export declare function sentinelFor(
  caseId: string,
  suiteSeed: number,
  pairIndex: number,
  lane: string,
): string;
export declare function buildTrialPrompt(caseId: YorhaCaseId, sentinel: string): string;
export declare function buildPlan(
  args: YorhaCliArgs,
  projectRoot: string,
  now?: () => Date,
): YorhaPlan;
export declare function formatPlan(plan: YorhaPlan, keyPresence?: Record<string, boolean>): string;
export declare function summarizeCaptureDir(dir: string): CaptureDirSummary;
export declare function verifyCaptureCompleteness(
  api2Dir: string,
  agentnDir: string,
): CaptureCompleteness;
export declare function runYorhaCapture(
  args: YorhaCliArgs,
  deps?: YorhaDependencies,
): Promise<YorhaRunResult>;
export declare function main(argv?: readonly string[], deps?: YorhaDependencies): Promise<number>;
