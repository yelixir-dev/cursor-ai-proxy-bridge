import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  CASE_IDS,
  DEFAULT_MAX_REQ_BINS,
  DEFAULT_MAX_RES_BINS,
  DEFAULT_PORT_A,
  DEFAULT_PORT_B,
  FORBIDDEN_PORTS,
  NativeRunError,
  SEED,
  TARGET_AGENTN,
  TARGET_API2,
  buildNativeRunPlan,
  formatSpawnPlan,
  parseArgs,
  promptFor,
  runNativeCapture,
  sentinelFor,
  verifyCaptureCompleteness,
  type NativeRunDependencies,
  type NativeRunOptions,
  type NativeRunPlan,
} from '../scripts/wire-capture/run-native.mjs';

const SCRIPT = 'scripts/wire-capture/run-native.mjs';
const roots: string[] = [];

function tmp(label: string): string {
  const base = process.env.TMPDIR ?? tmpdir();
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, `wire-native-${label}-`));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  while (roots.length > 0) {
    const dir = roots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function options(overrides: Partial<NativeRunOptions> = {}): NativeRunOptions {
  return {
    caseId: 'tool_parallel_two',
    dryRun: true,
    captureDir: join(tmp('cap'), 'capture'),
    portA: DEFAULT_PORT_A,
    portB: DEFAULT_PORT_B,
    timeoutMs: 5_000,
    omoBin: '/tmp/fake-omo',
    cursorAgentBin: '/tmp/fake-cursor-agent',
    childApiEndpoint: null,
    authStorePath: join(tmp('auth'), 'missing-auth.json'),
    modelStorePath: join(tmp('models'), 'missing-models.json'),
    maxReqBins: DEFAULT_MAX_REQ_BINS,
    maxResBins: DEFAULT_MAX_RES_BINS,
    ...overrides,
  };
}

function expectedSentinel(caseId: string): string {
  const digest = createHash('sha256')
    .update(`${caseId}\u0000${SEED}\u0000${0}\u0000native`)
    .digest('hex')
    .slice(0, 12)
    .toUpperCase();
  return `BENCH_${caseId.toUpperCase()}_NATIVE_${digest}`;
}

class FakeChild extends EventEmitter {
  static seq = 0;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 612_001 + FakeChild.seq;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killCalls: NodeJS.Signals[] = [];
  private closed = false;

  constructor() {
    super();
    FakeChild.seq += 1;
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killCalls.push(signal);
    this.close(null, signal);
    return true;
  }

  close(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    if (this.closed) return;
    this.closed = true;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }
}

function stubSpawn(onSpawn?: (child: FakeChild, command: string, args: readonly string[]) => void) {
  const children: FakeChild[] = [];
  const spawn = (command: string, args: readonly string[], _options: SpawnOptions) => {
    const child = new FakeChild();
    children.push(child);
    onSpawn?.(child, command, args);
    return child as unknown as ChildProcess;
  };
  return { spawn, children };
}

function recordProcessGroupKills(): {
  calls: Array<{ pid: number; signal: NodeJS.Signals | number | undefined }>;
  restore: () => void;
} {
  const calls: Array<{ pid: number; signal: NodeJS.Signals | number | undefined }> = [];
  const original = process.kill.bind(process);
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    if (pid < 0) calls.push({ pid, signal });
    return original(pid, signal);
  }) as typeof process.kill;
  return {
    calls,
    restore: () => {
      process.kill = original;
    },
  };
}

function stubCerts(): NativeRunDependencies['generateCerts'] {
  return ({ out }) => {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'ca.crt'), 'ca');
    writeFileSync(join(out, 'leaf.crt'), 'leaf');
    writeFileSync(join(out, 'leaf.key'), 'key');
    return {
      caCrt: join(out, 'ca.crt'),
      caKey: join(out, 'ca.key'),
      leafCrt: join(out, 'leaf.crt'),
      leafKey: join(out, 'leaf.key'),
    };
  };
}

function stubFixture(root: string): NativeRunDependencies['createFixture'] {
  return async () => ({
    rootDir: root,
    cwd: join(root, 'workspace'),
    agentDir: join(root, 'agent'),
    sessionDir: join(root, 'sessions'),
    toolExtensionPath: join(root, 'benchmark-tools.mjs'),
    dispose: async () => undefined,
  });
}

function plantCompleteCaptures(plan: NativeRunPlan): void {
  mkdirSync(plan.dirs.api2, { recursive: true });
  mkdirSync(plan.dirs.agentn, { recursive: true });
  writeFileSync(
    join(plan.dirs.api2, 'unary-api2-cursor-sh-_aiserver.v1.Foo-1.bin'),
    Buffer.from('api2'),
  );
  writeFileSync(join(plan.dirs.api2, 'lifecycle.ndjson'), '{"event":"open"}\n');
  writeFileSync(join(plan.dirs.agentn, 'H2-1-req-00.bin'), Buffer.from('run'));
  writeFileSync(join(plan.dirs.agentn, 'lifecycle.ndjson'), '{"event":"open"}\n');
}

describe('native-lane capture runner plan', () => {
  it('parses F3 case flags and default proxy ports 18443/18444', () => {
    // Given: CLI argv for a dry-run of the parallel tool case.
    const argv = ['--case', 'tool_parallel_two', '--dry-run'];

    // When: arguments are parsed.
    const parsed = parseArgs(argv);

    // Then: F3 case id is kept and the sibling yorha ports stay unused.
    expect(parsed.caseId).toBe('tool_parallel_two');
    expect(parsed.dryRun).toBe(true);
    expect(parsed.portA).toBe(18443);
    expect(parsed.portB).toBe(18444);
    expect(FORBIDDEN_PORTS.has(parsed.portA)).toBe(false);
    expect(FORBIDDEN_PORTS.has(parsed.portB)).toBe(false);
  });

  it('rejects reserved ports used by the sibling yorha runner and the bridge', () => {
    // Given: a reserved port from the concurrent yorha runner.
    // When/Then: parseArgs names the forbidden flag instead of binding it.
    expect(() => parseArgs(['--case', 'tool_parallel_two', '--port-a', '28443'])).toThrow(
      NativeRunError,
    );
    expect(() => parseArgs(['--case', 'tool_parallel_two', '--port-b', '28444'])).toThrow(
      /forbidden --port-b 28444/,
    );
    expect(() => parseArgs(['--case', 'tool_parallel_two', '--port-a', '9997'])).toThrow(
      /forbidden --port-a 9997/,
    );
    expect(() => parseArgs(['--case', 'cancel_after_first_event', '--port-b', '9996'])).toThrow(
      /forbidden --port-b 9996/,
    );
  });

  it('builds the F3 native sentinel, prompt, and OMO/cursor-agent spawn plan', () => {
    // Given: the sequential F3 case with an explicit capture dir and fake bins.
    const opts = options({ caseId: 'tool_sequential_two_round' });

    // When: the spawn plan is constructed without executing it.
    const plan = buildNativeRunPlan(opts);
    const printed = formatSpawnPlan(plan);

    // Then: sentinel/seed match the F3 driver formula and both proxies target production hosts.
    expect(CASE_IDS).toEqual([
      'tool_parallel_two',
      'tool_sequential_two_round',
      'cancel_after_first_event',
    ]);
    expect(plan.lane).toBe('native');
    expect(plan.seed).toBe(20260818);
    expect(plan.pairIndex).toBe(0);
    expect(plan.sentinel).toBe(expectedSentinel('tool_sequential_two_round'));
    expect(plan.sentinel).toBe(sentinelFor('tool_sequential_two_round', SEED, 0, 'native'));
    expect(plan.omoSeed).toBe('20260818-tool_sequential_two_round-0-native');
    expect(plan.prompt).toBe(promptFor('tool_sequential_two_round', plan.sentinel));
    expect(plan.ports).toEqual({ api2: 18443, agentn: 18444 });
    expect(plan.targets).toEqual({ api2: TARGET_API2, agentn: TARGET_AGENTN });
    expect(plan.proxies[0]?.args).toEqual(
      expect.arrayContaining(['--port', '18443', '--target-host', 'api2.cursor.sh']),
    );
    expect(plan.proxies[1]?.args).toEqual(
      expect.arrayContaining(['--port', '18444', '--target-host', 'agentn.global.api5.cursor.sh']),
    );
    expect(plan.omo.args).toEqual(
      expect.arrayContaining(['--provider', 'cursor', '--model', 'composer-2.5', '--offline']),
    );
    expect(plan.omo.env?.CURSOR_API_ENDPOINT).toBe('https://127.0.0.1:18443');
    expect(plan.omo.env?.NODE_EXTRA_CA_CERTS).toBe(plan.certs.caCrt);
    expect(plan.omo.env?.CURSOR_AGENT_EXECUTABLE).toBe(plan.cursorAgent.wrapperPath);
    expect(plan.cursorAgent.args).toEqual([
      '--endpoint',
      'https://127.0.0.1:18443',
      '--agent-endpoint',
      'https://127.0.0.1:18444',
    ]);
    expect(plan.execute.args).toEqual(
      expect.arrayContaining([
        '--print',
        '--endpoint',
        'https://127.0.0.1:18443',
        '--agent-endpoint',
        'https://127.0.0.1:18444',
      ]),
    );
    expect(plan.cursorAgent.env.CURSOR_API_ENDPOINT).toBe('https://127.0.0.1:18443');
    expect(printed).toContain('"lane": "native"');
    expect(printed).toContain('--agent-endpoint');
    expect(printed).not.toContain('28443');
    expect(printed).not.toContain('28444');
  });

  it('defaults proxy frame caps to 200/500 and passes them through', () => {
    // Given: a dry-run plan with no cap overrides.
    const parsed = parseArgs(['--case', 'tool_parallel_two', '--dry-run']);
    const plan = buildNativeRunPlan(options());

    // Then: both proxies get the raised caps, not the proxy.mjs 12/40 defaults.
    expect(parsed.maxReqBins).toBe(200);
    expect(parsed.maxResBins).toBe(500);
    expect(DEFAULT_MAX_REQ_BINS).toBe(200);
    expect(DEFAULT_MAX_RES_BINS).toBe(500);
    for (const proxy of plan.proxies) {
      expect(proxy.args).toEqual(
        expect.arrayContaining(['--max-req-bins', '200', '--max-res-bins', '500']),
      );
    }
  });

  it('passes explicit --max-req-bins/--max-res-bins through to both proxies', () => {
    // Given: custom caps that differ from both runner and proxy defaults.
    const parsed = parseArgs([
      '--case',
      'tool_parallel_two',
      '--max-req-bins',
      '17',
      '--max-res-bins',
      '19',
    ]);
    const plan = buildNativeRunPlan(
      options({ maxReqBins: parsed.maxReqBins, maxResBins: parsed.maxResBins }),
    );

    // Then: the exact integers are on both proxy argv lists.
    expect(parsed.maxReqBins).toBe(17);
    expect(parsed.maxResBins).toBe(19);
    for (const proxy of plan.proxies) {
      expect(proxy.args).toEqual(
        expect.arrayContaining(['--max-req-bins', '17', '--max-res-bins', '19']),
      );
    }
  });

  it('rejects malformed bin-cap flags with named bad_args', () => {
    expect(() => parseArgs(['--case', 'tool_parallel_two', '--max-req-bins', '-1'])).toThrow(
      /invalid --max-req-bins -1/,
    );
    expect(() => parseArgs(['--case', 'tool_parallel_two', '--max-res-bins', 'nope'])).toThrow(
      /invalid --max-res-bins/,
    );
    expect(() => parseArgs(['--case', 'tool_parallel_two', '--max-req-bins'])).toThrow(
      /missing value for --max-req-bins/,
    );
    try {
      parseArgs(['--case', 'tool_parallel_two', '--max-req-bins', '1.5']);
      throw new Error('expected parseArgs to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(NativeRunError);
      expect((error as NativeRunError).reason).toBe('bad_args');
    }
  });

  it('marks cancel_after_first_event for abort-after-first-visible-event', () => {
    // Given: the cheapest F3 cancellation surface.
    const plan = buildNativeRunPlan(options({ caseId: 'cancel_after_first_event' }));

    // When/Then: the plan carries the F3 cancel policy and the default text prompt.
    expect(plan.cancelAfterFirstEvent).toBe(true);
    expect(plan.prompt).toContain(plan.sentinel);
    expect(plan.prompt.startsWith('Reply with exactly this token')).toBe(true);
  });
});

describe('native-lane dry-run CLI', () => {
  it('prints the spawn plan and exits 0 without spawning or writing captures', () => {
    // Given: a capture dir that must stay absent if dry-run is honest.
    const captureDir = join(tmp('dry'), 'must-not-exist');

    // When: the CLI is invoked with --dry-run.
    const result = spawnSync(
      process.execPath,
      [SCRIPT, '--case', 'tool_parallel_two', '--dry-run', '--capture-dir', captureDir],
      {
        encoding: 'utf8',
        env: { ...process.env, NO_COLOR: '1' },
      },
    );

    // Then: exit 0, the plan is printed, and nothing is created on disk.
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"caseId": "tool_parallel_two"');
    expect(result.stdout).toContain('"18443"');
    expect(result.stdout).toContain('"18444"');
    expect(result.stdout).toContain('CURSOR_API_ENDPOINT');
    expect(result.stdout).toContain('--agent-endpoint');
    expect(result.stdout).toContain('--max-req-bins');
    expect(result.stdout).toContain('"200"');
    expect(result.stdout).toContain('--max-res-bins');
    expect(result.stdout).toContain('"500"');
    expect(result.stderr).toBe('');
    expect(() => readFileSync(join(captureDir, 'receipt.json'))).toThrow();
  });
});

describe('native-lane capture completeness', () => {
  it('fails empty dirs with the named empty_capture reason', () => {
    // Given: a plan whose proxy dirs have not received any frames.
    const plan = buildNativeRunPlan(options());
    mkdirSync(plan.dirs.api2, { recursive: true });
    mkdirSync(plan.dirs.agentn, { recursive: true });

    // When: completeness is checked.
    const result = verifyCaptureCompleteness(plan);

    // Then: the runner names the empty-capture failure instead of succeeding.
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('empty_capture');
  });

  it('accepts non-empty unary api2 and H2 Run agentn captures plus lifecycle logs', () => {
    // Given: planted non-empty capture bytes in both proxy dirs.
    const plan = buildNativeRunPlan(options());
    plantCompleteCaptures(plan);

    // When: completeness is checked.
    const result = verifyCaptureCompleteness(plan);

    // Then: both lanes are present.
    expect(result.ok).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.completeness.api2_unary_count).toBe(1);
    expect(result.completeness.agentn_run_req_count).toBe(1);
    expect(result.completeness.api2_lifecycle).toBe(true);
    expect(result.completeness.agentn_lifecycle).toBe(true);
  });

  it('does not require H2 lifecycle on the unary api2 dir', () => {
    // Given: unary api2 bins and agentn Run frames with lifecycle only on agentn.
    const plan = buildNativeRunPlan(options());
    mkdirSync(plan.dirs.api2, { recursive: true });
    mkdirSync(plan.dirs.agentn, { recursive: true });
    writeFileSync(
      join(plan.dirs.api2, 'unary-api2-cursor-sh-_aiserver.v1.Foo-1.bin'),
      Buffer.from('api2'),
    );
    writeFileSync(join(plan.dirs.agentn, 'H2-1-req-00.bin'), Buffer.from('run'));
    writeFileSync(join(plan.dirs.agentn, 'lifecycle.ndjson'), '{"event":"open"}\n');

    // When: completeness is checked.
    const result = verifyCaptureCompleteness(plan);

    // Then: api2 HTTP/1.1 unary without lifecycle is still complete.
    expect(result.ok).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.completeness.api2_lifecycle).toBe(false);
    expect(result.completeness.agentn_lifecycle).toBe(true);
  });
});

describe('native-lane execute with stubbed spawn', () => {
  it('spawns the proxy pair then OMO with the planned env and writes a receipt', async () => {
    // Given: stubbed certs, fixture, and child processes that emit listen/exit.
    const opts = options({ dryRun: false, timeoutMs: 2_000 });
    const plan = buildNativeRunPlan(opts);
    const { spawn, children } = stubSpawn((child, _command, args) => {
      if (args.includes('--target-host')) {
        child.stdout.write('listening on https://127.0.0.1:0 -> https://example.test (h2+h1)\n');
        return;
      }
      plantCompleteCaptures(plan);
      child.stdout.write(`${JSON.stringify({ type: 'message_end' })}\n`);
      child.close(0, null);
    });
    const fixtureRoot = tmp('fx');

    // When: the runner executes against the stubs.
    const result = await runNativeCapture(opts, {
      spawn,
      generateCerts: ({ out }) => {
        mkdirSync(out, { recursive: true });
        writeFileSync(join(out, 'ca.crt'), 'ca');
        writeFileSync(join(out, 'leaf.crt'), 'leaf');
        writeFileSync(join(out, 'leaf.key'), 'key');
        return {
          caCrt: join(out, 'ca.crt'),
          caKey: join(out, 'ca.key'),
          leafCrt: join(out, 'leaf.crt'),
          leafKey: join(out, 'leaf.key'),
        };
      },
      createFixture: async () => ({
        rootDir: fixtureRoot,
        cwd: join(fixtureRoot, 'workspace'),
        agentDir: join(fixtureRoot, 'agent'),
        sessionDir: join(fixtureRoot, 'sessions'),
        toolExtensionPath: join(fixtureRoot, 'benchmark-tools.mjs'),
        dispose: async () => undefined,
      }),
      terminationGraceMs: 20,
    });

    // Then: two proxies + OMO were spawned with the capture env, and a receipt lands.
    expect(result.ok).toBe(true);
    expect(children).toHaveLength(3);
    const omo = children[2];
    expect(omo).toBeDefined();
    expect(result.receiptPath).toBe(join(plan.dirs.capture, 'receipt.json'));
    const receipt = JSON.parse(readFileSync(result.receiptPath ?? '', 'utf8')) as {
      ok: boolean;
      sentinel: string;
    };
    expect(receipt.ok).toBe(true);
    expect(receipt.sentinel).toBe(plan.sentinel);
  });

  it('exits through NativeRunError empty_capture when the child never hits the proxies', async () => {
    // Given: stubbed children that listen and exit without writing capture bytes.
    const opts = options({
      dryRun: false,
      timeoutMs: 2_000,
      childApiEndpoint: 'https://127.0.0.1:1',
    });
    const { spawn } = stubSpawn((child, _command, args) => {
      if (args.includes('--target-host')) {
        child.stdout.write('listening on https://127.0.0.1:0 -> https://example.test (h2+h1)\n');
        return;
      }
      child.close(0, null);
    });
    const fixtureRoot = tmp('fx-empty');

    // When: the runner executes against a closed-port child endpoint.
    let caught: unknown;
    try {
      await runNativeCapture(opts, {
        spawn,
        generateCerts: ({ out }) => {
          mkdirSync(out, { recursive: true });
          writeFileSync(join(out, 'ca.crt'), 'ca');
          return {
            caCrt: join(out, 'ca.crt'),
            caKey: join(out, 'ca.key'),
            leafCrt: join(out, 'leaf.crt'),
            leafKey: join(out, 'leaf.key'),
          };
        },
        createFixture: async () => ({
          rootDir: fixtureRoot,
          cwd: join(fixtureRoot, 'workspace'),
          agentDir: join(fixtureRoot, 'agent'),
          sessionDir: join(fixtureRoot, 'sessions'),
          toolExtensionPath: join(fixtureRoot, 'benchmark-tools.mjs'),
          dispose: async () => undefined,
        }),
        terminationGraceMs: 20,
      });
    } catch (error) {
      caught = error;
    }

    // Then: the named empty_capture reason is raised after the receipt is written.
    expect(caught).toBeInstanceOf(NativeRunError);
    expect((caught as NativeRunError).reason).toBe('empty_capture');
    const receipt = JSON.parse(
      readFileSync(join(buildNativeRunPlan(opts).dirs.capture, 'receipt.json'), 'utf8'),
    ) as { ok: boolean; reason: string };
    expect(receipt.ok).toBe(false);
    expect(receipt.reason).toBe('empty_capture');
  });

  it('exits non-zero and SIGTERMs proxies when the agent spawn emits ENOENT', async () => {
    // Given: listening proxies and an agent child that fails spawn with ENOENT (close never fires).
    const opts = options({ dryRun: false, timeoutMs: 2_000 });
    const { spawn, children } = stubSpawn((child, _command, args) => {
      if (args.includes('--target-host')) {
        child.stdout.write('listening on https://127.0.0.1:0 -> https://example.test (h2+h1)\n');
        return;
      }
      const err = new Error('spawn ENOENT: no such file or directory') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      queueMicrotask(() => child.emit('error', err));
    });
    const recorder = recordProcessGroupKills();
    const fixtureRoot = tmp('fx-enoent');

    // When: the runner executes against the failing agent spawn.
    let caught: unknown;
    try {
      await runNativeCapture(opts, {
        spawn,
        generateCerts: stubCerts(),
        createFixture: stubFixture(fixtureRoot),
        terminationGraceMs: 20,
      });
    } catch (error) {
      caught = error;
    } finally {
      recorder.restore();
    }

    // Then: named spawn failure, non-success, and both proxy process groups were SIGTERM'd.
    expect(caught).toBeInstanceOf(NativeRunError);
    expect((caught as NativeRunError).reason).toBe('spawn_error');
    expect((caught as NativeRunError).message).toMatch(/ENOENT/);
    expect(children.length).toBeGreaterThanOrEqual(3);
    const proxies = children.slice(0, 2);
    expect(proxies).toHaveLength(2);
    for (const proxy of proxies) {
      expect(proxy.killCalls).toContain('SIGTERM');
      expect(recorder.calls).toContainEqual({ pid: -proxy.pid, signal: 'SIGTERM' });
    }
    const receipt = JSON.parse(
      readFileSync(join(buildNativeRunPlan(opts).dirs.capture, 'receipt.json'), 'utf8'),
    ) as { ok: boolean; reason: string };
    expect(receipt.ok).toBe(false);
    expect(receipt.reason).toBe('spawn_error');
  });
});
