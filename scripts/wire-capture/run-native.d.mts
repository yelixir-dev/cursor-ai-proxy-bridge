export const CASE_IDS: readonly string[];
export const SEED: number;
export const DEFAULT_PORT_A: number;
export const DEFAULT_PORT_B: number;
export const FORBIDDEN_PORTS: Set<number>;
export const TARGET_API2: string;
export const TARGET_AGENTN: string;

export class NativeRunError extends Error {
  reason: string;
  constructor(reason: string, message: string);
}

export interface NativeRunOptions {
  caseId: string;
  dryRun: boolean;
  captureDir: string | null;
  portA: number;
  portB: number;
  timeoutMs: number;
  omoBin: string | null;
  cursorAgentBin: string | null;
  childApiEndpoint: string | null;
  authStorePath: string | null;
  modelStorePath: string | null;
}

export interface SpawnSpec {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
}

export interface NativeRunPlan {
  caseId: string;
  lane: 'native';
  seed: number;
  pairIndex: number;
  sentinel: string;
  omoSeed: string;
  prompt: string;
  timeoutMs: number;
  cancelAfterFirstEvent: boolean;
  dryRun: boolean;
  authStorePath: string;
  modelStorePath: string;
  dirs: {
    capture: string;
    certs: string;
    api2: string;
    agentn: string;
    fixture: string;
    wrapper: string;
  };
  ports: { api2: number; agentn: number };
  targets: { api2: string; agentn: string };
  certs: {
    command: string;
    args: string[];
    out: string;
    caCrt: string;
    leafCrt: string;
    leafKey: string;
  };
  proxies: { name: string; command: string; args: string[] }[];
  omo: SpawnSpec;
  execute: SpawnSpec;
  cursorAgent: {
    wrapperPath: string;
    realBin: string;
    args: string[];
    env: Record<string, string>;
  };
}

export interface CaptureCompleteness {
  api2_bin_count: number;
  agentn_bin_count: number;
  api2_unary_count: number;
  agentn_run_req_count: number;
  api2_lifecycle: boolean;
  agentn_lifecycle: boolean;
  api2_files: string[];
  agentn_files: string[];
}

export interface CompletenessResult {
  ok: boolean;
  reason: string | null;
  completeness: CaptureCompleteness;
}

export interface NativeRunReceipt {
  schema_version: number;
  lane: 'native';
  case_id: string;
  seed: number;
  pair_index: number;
  sentinel: string;
  omo_seed: string;
  ports: { api2: number; agentn: number };
  targets: { api2: string; agentn: string };
  capture_dir: string;
  certs_dir: string;
  omo_exit: { code: number | null; signal: string | null };
  ok: boolean;
  reason: string | null;
  completeness: CaptureCompleteness;
  started_at: string;
  ended_at: string;
}

export interface NativeRunResult {
  ok: boolean;
  dryRun: boolean;
  plan: NativeRunPlan;
  reason: string | null;
  receiptPath: string | null;
  receipt?: NativeRunReceipt;
}

export interface NativeRunDependencies {
  spawn?: (
    command: string,
    args: readonly string[],
    options: import('node:child_process').SpawnOptions,
  ) => import('node:child_process').ChildProcess;
  generateCerts?: (options: { out: string; days?: number }) => {
    caCrt: string;
    caKey: string;
    leafCrt: string;
    leafKey: string;
  };
  createFixture?: (plan: NativeRunPlan) => Promise<{
    rootDir: string;
    cwd: string;
    agentDir: string;
    sessionDir: string;
    toolExtensionPath: string;
    dispose(): Promise<void>;
  }>;
  terminationGraceMs?: number;
}

export declare function parseArgs(argv: string[]): NativeRunOptions;
export declare function sentinelFor(
  caseId: string,
  seed: number,
  pairIndex: number,
  lane: string,
): string;
export declare function promptFor(caseId: string, sentinel: string): string;
export declare function buildNativeRunPlan(options: NativeRunOptions): NativeRunPlan;
export declare function formatSpawnPlan(plan: NativeRunPlan): string;
export declare function verifyCaptureCompleteness(plan: NativeRunPlan): CompletenessResult;
export declare function runNativeCapture(
  options: NativeRunOptions,
  deps?: NativeRunDependencies,
): Promise<NativeRunResult>;
