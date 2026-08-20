import { spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_BRIDGE_PORT,
  DEFAULT_PORT_A,
  DEFAULT_PORT_B,
  LANE,
  SEED,
  buildPlan,
  buildTrialPrompt,
  formatPlan,
  parseArgs,
  runYorhaCapture,
  sentinelFor,
  verifyCaptureCompleteness,
  type YorhaCliArgs,
  type YorhaSpawn,
} from '../scripts/wire-capture/run-yorha.mjs';

const PROJECT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly pid: number;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killCalls: NodeJS.Signals[] = [];
  stdinChunks: Buffer[] = [];

  constructor(pid: number) {
    super();
    this.pid = pid;
    this.stdin.on('data', (chunk: Buffer) => this.stdinChunks.push(chunk));
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killCalls.push(signal);
    this.exit(null, signal);
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }
}

interface SpawnCall {
  command: string;
  args: readonly string[];
  options: SpawnOptions;
  child: FakeChild;
  role: 'proxy-a' | 'proxy-b' | 'bridge' | 'omo';
}

function roleOf(args: readonly string[]): SpawnCall['role'] {
  const joined = args.join(' ');
  if (joined.includes('proxy.mjs') && joined.includes('--port')) {
    const index = args.indexOf('--port');
    const port = args[index + 1];
    return port === String(DEFAULT_PORT_A) ? 'proxy-a' : 'proxy-b';
  }
  if (joined.includes(`${path.sep}index.js`) || joined.includes(`${path.sep}index.ts`)) {
    return 'bridge';
  }
  return 'omo';
}

function tmpRoot(): string {
  const base = process.env.TMPDIR ?? os.tmpdir();
  mkdirSync(base, { recursive: true });
  return mkdtempSync(path.join(base, 'wire-capture-run-yorha-'));
}

function writeBin(dir: string, name: string, bytes: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, name), bytes);
}

function expectedSentinel(caseId: string): string {
  const digest = createHash('sha256')
    .update(`${caseId}\u0000${SEED}\u0000${0}\u0000${LANE}`)
    .digest('hex')
    .slice(0, 12)
    .toUpperCase();
  return `BENCH_${caseId.toUpperCase()}_${LANE.toUpperCase()}_${digest}`;
}

function baseArgs(captureDir: string, extra: Partial<YorhaCliArgs> = {}): YorhaCliArgs {
  return {
    case: 'tool_parallel_two',
    dryRun: false,
    captureDir,
    portA: DEFAULT_PORT_A,
    portB: DEFAULT_PORT_B,
    bridgePort: DEFAULT_BRIDGE_PORT,
    targetA: 'api2.cursor.sh',
    targetB: 'agentn.global.api5.cursor.sh',
    timeoutMs: 1_000,
    probeTimeoutMs: 200,
    bootTimeoutMs: 1_000,
    ...extra,
  };
}

const leftovers: string[] = [];

afterEach(() => {
  for (const dir of leftovers.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('wire-capture yorha runner', () => {
  it('defaults ports away from the 9997/18443 sibling lane and matches F3 sentinels', () => {
    const parsed = parseArgs(['--case', 'tool_parallel_two', '--dry-run']);
    expect(parsed.portA).toBe(28443);
    expect(parsed.portB).toBe(28444);
    expect(parsed.bridgePort).toBe(9998);
    expect(parsed.dryRun).toBe(true);
    expect(sentinelFor('tool_parallel_two', SEED, 0, 'yorha')).toBe(
      expectedSentinel('tool_parallel_two'),
    );
    expect(sentinelFor('tool_sequential_two_round', SEED, 0, 'yorha')).toBe(
      expectedSentinel('tool_sequential_two_round'),
    );
    expect(sentinelFor('cancel_after_first_event', SEED, 0, 'yorha')).toBe(
      expectedSentinel('cancel_after_first_event'),
    );
    expect(buildTrialPrompt('tool_parallel_two', 'TOK')).toContain('{"value":"TOK"}');
    expect(buildTrialPrompt('tool_sequential_two_round', 'TOK')).toContain('"key":"ALPHA"');
    expect(buildTrialPrompt('cancel_after_first_event', 'TOK')).toContain('TOK');
  });

  it('dry-run prints the boot+spawn plan without spawning or touching the network', async () => {
    const captureDir = tmpRoot();
    leftovers.push(captureDir);
    const spawnCalls: SpawnCall[] = [];
    const result = await runYorhaCapture(baseArgs(captureDir, { dryRun: true }), {
      spawn: ((command, args, options) => {
        spawnCalls.push({
          command,
          args,
          options,
          child: new FakeChild(1),
          role: roleOf(args),
        });
        return spawnCalls[spawnCalls.length - 1]?.child as unknown as ChildProcess;
      }) satisfies YorhaSpawn,
      generateCerts: () => {
        throw new Error('certs must not run during dry-run');
      },
      probeBridge: async () => {
        throw new Error('probe must not run during dry-run');
      },
      env: {
        CURSOR_API_KEY: 'SUPERSECRET_CURSOR',
        CURSOR_BRIDGE_API_KEY: 'SUPERSECRET_BRIDGE',
      },
    });
    expect(result.exitCode).toBe(0);
    expect(result.outcome).toBe('dry_run');
    expect(spawnCalls).toEqual([]);
    expect(result.stdout).toContain('yorha-lane capture plan');
    expect(result.stdout).toContain('CURSOR_BRIDGE_CURSOR_API_ENDPOINT=https://127.0.0.1:28443');
    expect(result.stdout).toContain('CURSOR_BRIDGE_CURSOR_AGENT_ENDPOINT=https://127.0.0.1:28444');
    expect(result.stdout).toContain('CURSOR_BRIDGE_PORT=9998');
    expect(result.stdout).toContain('omo_provider: yorha');
    expect(result.stdout).toContain(`sentinel: ${expectedSentinel('tool_parallel_two')}`);
    expect(result.stdout).toContain('GET http://127.0.0.1:9998/v1/models');
    expect(result.stdout).not.toContain('SUPERSECRET_CURSOR');
    expect(result.stdout).not.toContain('SUPERSECRET_BRIDGE');
    expect(result.stdout).toContain('CURSOR_API_KEY=<from-env>');
  });

  it('CLI --dry-run exits 0 and prints the default 28443/28444/9998 boot plan', () => {
    const ran = spawnSync(
      process.execPath,
      ['scripts/wire-capture/run-yorha.mjs', '--case', 'tool_parallel_two', '--dry-run'],
      { cwd: PROJECT, encoding: 'utf8', timeout: 5_000, env: { ...process.env, NO_COLOR: '1' } },
    );
    expect(ran.status).toBe(0);
    expect(ran.stdout).toContain('--port 28443');
    expect(ran.stdout).toContain('--port 28444');
    expect(ran.stdout).toContain('bridge_port: 9998');
    expect(ran.stdout).toContain('--provider yorha');
    expect(ran.stdout).toContain('--target-host api2.cursor.sh');
    expect(ran.stdout).toContain('--target-host agentn.global.api5.cursor.sh');
  });

  it('rejects unknown cases', () => {
    expect(() => parseArgs(['--case', 'not_a_case'])).toThrow(/unsupported --case/);
  });

  it('verifyCaptureCompleteness requires non-empty .bin bytes in both proxy dirs', () => {
    const root = tmpRoot();
    leftovers.push(root);
    const api2 = path.join(root, 'api2');
    const agentn = path.join(root, 'agentn');
    mkdirSync(api2, { recursive: true });
    mkdirSync(agentn, { recursive: true });
    writeFileSync(path.join(api2, 'lifecycle.ndjson'), '{}\n');
    expect(verifyCaptureCompleteness(api2, agentn).complete).toBe(false);
    writeBin(api2, 'unary-api2.bin', 'abc');
    expect(verifyCaptureCompleteness(api2, agentn).gaps).toContain(
      'agentn capture empty (expected Run .bin frames)',
    );
    writeBin(agentn, 'H2-1-req-00.bin', 'def');
    expect(verifyCaptureCompleteness(api2, agentn).complete).toBe(true);
    expect(verifyCaptureCompleteness(api2, agentn).api2.bytes).toBe(3);
  });

  it('boots proxies+bridge, probes, drives OMO, and records complete captures', async () => {
    const captureDir = tmpRoot();
    leftovers.push(captureDir);
    const fixtureParent = tmpRoot();
    leftovers.push(fixtureParent);
    const calls: SpawnCall[] = [];
    let nextPid = 40_000;
    const spawnImpl: YorhaSpawn = (command, args, options) => {
      const child = new FakeChild(nextPid);
      nextPid += 1;
      const call: SpawnCall = { command, args, options, child, role: roleOf(args) };
      calls.push(call);
      queueMicrotask(() => {
        if (call.role === 'proxy-a' || call.role === 'proxy-b') {
          child.stdout.write('listening on https://127.0.0.1:0 -> upstream\n');
        }
        if (call.role === 'bridge') {
          child.stdout.write('cursor-ai-bridge listening on http://127.0.0.1:9998\n');
        }
        if (call.role === 'omo') {
          writeBin(path.join(captureDir, 'api2'), 'unary.bin', 'api-bytes');
          writeBin(path.join(captureDir, 'agentn'), 'H2-1-req-00.bin', 'run-bytes');
          child.stdout.write('{"type":"message_end"}\n');
          child.exit(0, null);
        }
      });
      return child as unknown as ChildProcess;
    };
    const result = await runYorhaCapture(baseArgs(captureDir), {
      spawn: spawnImpl,
      generateCerts: ({ out }) => {
        mkdirSync(out, { recursive: true });
        writeFileSync(path.join(out, 'ca.crt'), 'ca');
        writeFileSync(path.join(out, 'ca.key'), 'cakey');
        writeFileSync(path.join(out, 'leaf.crt'), 'leaf');
        writeFileSync(path.join(out, 'leaf.key'), 'leafkey');
        return {
          caCrt: path.join(out, 'ca.crt'),
          caKey: path.join(out, 'ca.key'),
          leafCrt: path.join(out, 'leaf.crt'),
          leafKey: path.join(out, 'leaf.key'),
        };
      },
      probeBridge: async () => ({ status: 200 }),
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        CURSOR_API_KEY: 'cursor-test-key',
        CURSOR_BRIDGE_API_KEY: 'bridge-test-key',
      },
      mkdtemp: (prefix) => mkdtempSync(path.join(fixtureParent, path.basename(prefix))),
    });
    expect(result.exitCode).toBe(0);
    expect(result.outcome).toBe('completed');
    expect(result.receipt.captures.api2.bytes).toBeGreaterThan(0);
    expect(result.receipt.captures.agentn.bytes).toBeGreaterThan(0);
    expect(calls.map((call) => call.role)).toEqual(['proxy-a', 'proxy-b', 'bridge', 'omo']);
    const bridgeEnv = calls.find((call) => call.role === 'bridge')?.options.env;
    expect(bridgeEnv?.CURSOR_BRIDGE_CURSOR_API_ENDPOINT).toBe('https://127.0.0.1:28443');
    expect(bridgeEnv?.CURSOR_BRIDGE_CURSOR_AGENT_ENDPOINT).toBe('https://127.0.0.1:28444');
    expect(bridgeEnv?.CURSOR_BRIDGE_PORT).toBe('9998');
    expect(bridgeEnv?.NODE_EXTRA_CA_CERTS).toContain(`${path.sep}ca.crt`);
    expect(calls.find((call) => call.role === 'omo')?.args).toContain('yorha');
    const omo = calls.find((call) => call.role === 'omo');
    expect(omo?.child.stdinChunks.join('').includes(result.plan.prompt)).toBe(true);
  });

  it('treats a stalled case with complete captures as success', async () => {
    const captureDir = tmpRoot();
    leftovers.push(captureDir);
    const fixtureParent = tmpRoot();
    leftovers.push(fixtureParent);
    const spawnImpl: YorhaSpawn = (_command, args, _options) => {
      const child = new FakeChild(50_000 + Math.floor(Math.random() * 1000));
      const role = roleOf(args);
      queueMicrotask(() => {
        if (role === 'proxy-a' || role === 'proxy-b') {
          child.stdout.write('listening on https://127.0.0.1:0 -> upstream\n');
        }
        if (role === 'bridge') {
          child.stdout.write('cursor-ai-bridge listening on http://127.0.0.1:9998\n');
        }
        if (role === 'omo') {
          writeBin(path.join(captureDir, 'api2'), 'unary.bin', 'api');
          writeBin(path.join(captureDir, 'agentn'), 'run.bin', 'run');
        }
      });
      return child as unknown as ChildProcess;
    };
    const result = await runYorhaCapture(baseArgs(captureDir, { timeoutMs: 50 }), {
      spawn: spawnImpl,
      generateCerts: ({ out }) => {
        mkdirSync(out, { recursive: true });
        return {
          caCrt: path.join(out, 'ca.crt'),
          caKey: path.join(out, 'ca.key'),
          leafCrt: path.join(out, 'leaf.crt'),
          leafKey: path.join(out, 'leaf.key'),
        };
      },
      probeBridge: async () => ({ status: 200 }),
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        CURSOR_API_KEY: 'cursor-test-key',
        CURSOR_BRIDGE_API_KEY: 'bridge-test-key',
      },
      mkdtemp: (prefix) => mkdtempSync(path.join(fixtureParent, path.basename(prefix))),
    });
    expect(result.exitCode).toBe(0);
    expect(result.outcome).toBe('stalled');
    expect(result.receipt.stall).toBe(true);
    expect(result.receipt.captures.api2.bytes).toBeGreaterThan(0);
    expect(result.receipt.captures.agentn.bytes).toBeGreaterThan(0);
  });

  it('surfaces a bridge probe failure and exits non-zero without driving OMO', async () => {
    const captureDir = tmpRoot();
    leftovers.push(captureDir);
    const roles: string[] = [];
    const spawnImpl: YorhaSpawn = (_command, args) => {
      const child = new FakeChild(60_000);
      const role = roleOf(args);
      roles.push(role);
      queueMicrotask(() => {
        if (role === 'proxy-a' || role === 'proxy-b') {
          child.stdout.write('listening on https://127.0.0.1:0 -> upstream\n');
        }
        if (role === 'bridge') {
          child.stdout.write('cursor-ai-bridge listening on http://127.0.0.1:9998\n');
        }
      });
      return child as unknown as ChildProcess;
    };
    const result = await runYorhaCapture(baseArgs(captureDir), {
      spawn: spawnImpl,
      generateCerts: ({ out }) => ({
        caCrt: path.join(out, 'ca.crt'),
        caKey: path.join(out, 'ca.key'),
        leafCrt: path.join(out, 'leaf.crt'),
        leafKey: path.join(out, 'leaf.key'),
      }),
      probeBridge: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:1 closed upstream port');
      },
      env: {
        PATH: process.env.PATH,
        CURSOR_API_KEY: 'cursor-test-key',
        CURSOR_BRIDGE_API_KEY: 'bridge-test-key',
      },
    });
    expect(result.exitCode).toBe(1);
    expect(result.outcome).toBe('probe_failed');
    expect(result.receipt.error).toContain('closed upstream port');
    expect(result.receipt.error).toContain('bridge probe failed against the proxy');
    expect(roles).toEqual(['proxy-a', 'proxy-b', 'bridge']);
  });

  it('cancels cancel_after_first_event only after a model-visible event', async () => {
    const captureDir = tmpRoot();
    leftovers.push(captureDir);
    const fixtureParent = tmpRoot();
    leftovers.push(fixtureParent);
    let omo: FakeChild | undefined;
    const spawnImpl: YorhaSpawn = (_command, args) => {
      const child = new FakeChild(70_000);
      const role = roleOf(args);
      if (role === 'omo') omo = child;
      queueMicrotask(() => {
        if (role === 'proxy-a' || role === 'proxy-b') {
          child.stdout.write('listening on https://127.0.0.1:0 -> upstream\n');
        }
        if (role === 'bridge') {
          child.stdout.write('cursor-ai-bridge listening on http://127.0.0.1:9998\n');
        }
        if (role === 'omo') {
          writeBin(path.join(captureDir, 'api2'), 'unary.bin', 'api');
          child.stdout.write('{"type":"session"}\n');
          queueMicrotask(() => {
            writeBin(path.join(captureDir, 'agentn'), 'H2-1-req-00.bin', 'run');
            child.stdout.write('{"type":"text_delta","delta":"x"}\n');
          });
        }
      });
      return child as unknown as ChildProcess;
    };
    const result = await runYorhaCapture(
      baseArgs(captureDir, { case: 'cancel_after_first_event', timeoutMs: 1_000 }),
      {
        spawn: spawnImpl,
        generateCerts: ({ out }) => ({
          caCrt: path.join(out, 'ca.crt'),
          caKey: path.join(out, 'ca.key'),
          leafCrt: path.join(out, 'leaf.crt'),
          leafKey: path.join(out, 'leaf.key'),
        }),
        probeBridge: async () => ({ status: 200 }),
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          CURSOR_API_KEY: 'cursor-test-key',
          CURSOR_BRIDGE_API_KEY: 'bridge-test-key',
        },
        mkdtemp: (prefix) => mkdtempSync(path.join(fixtureParent, path.basename(prefix))),
      },
    );
    expect(result.exitCode).toBe(0);
    expect(omo?.killCalls.length).toBeGreaterThan(0);
    expect(result.receipt.captures.agentn.bytes).toBeGreaterThan(0);
  });

  it('formatPlan never interpolates secret values', () => {
    const plan = buildPlan(baseArgs('/tmp/plan-capture'), PROJECT);
    const rendered = formatPlan(plan, { CURSOR_API_KEY: true, CURSOR_BRIDGE_API_KEY: true });
    expect(rendered).toContain('<from-env>');
    expect(rendered).not.toMatch(/CURSOR_API_KEY=[^<\n]/);
  });
});
