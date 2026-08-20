#!/usr/bin/env node
/* global AbortController, AbortSignal, clearTimeout, setTimeout */
// Native-lane wire-capture runner: fresh certs, api2+agentn capture proxies,
// then one F3 native-lane OMO trial (cursor-agent child) pointed at the proxies.
// Usage:
//   node run-native.mjs --case tool_parallel_two --dry-run
//   node run-native.mjs --case cancel_after_first_event --capture-dir <dir>
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generateCerts } from './gen-certs.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '../..');
const PROXY_PATH = path.join(SCRIPT_DIR, 'proxy.mjs');
const GEN_CERTS_PATH = path.join(SCRIPT_DIR, 'gen-certs.mjs');

const SEED = 20260818;
const LANE = 'native';
const DEFAULT_PORT_A = 18443;
const DEFAULT_PORT_B = 18444;
const TARGET_API2 = 'api2.cursor.sh';
const TARGET_AGENTN = 'agentn.global.api5.cursor.sh';
const DEFAULT_TIMEOUT_MS = 120_000;
const TERMINATION_GRACE_MS = 1_000;
const FORBIDDEN_PORTS = new Set([28443, 28444, 9997, 9996]);
const CASE_IDS = ['tool_parallel_two', 'tool_sequential_two_round', 'cancel_after_first_event'];
const PINNED_OMO = path.join(
  PROJECT_ROOT,
  '.omo/comparators/omo-ai-5.0.0-0.beta.9/node_modules/omo-ai/bin/omo.js',
);

class NativeRunError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'NativeRunError';
    this.reason = reason;
  }
}

function sentinelFor(caseId, seed, pairIndex, lane) {
  const digest = createHash('sha256')
    .update(`${caseId}\u0000${seed}\u0000${pairIndex}\u0000${lane}`)
    .digest('hex')
    .slice(0, 12)
    .toUpperCase();
  return `BENCH_${caseId.toUpperCase()}_${lane.toUpperCase()}_${digest}`;
}

function promptFor(caseId, sentinel) {
  switch (caseId) {
    case 'tool_parallel_two':
      return `Call the echo_value tool twice in the same turn with arguments exactly {"value":"${sentinel}"} and {"value":"${sentinel}_SECOND"}, then reply with exactly: DONE`;
    case 'tool_sequential_two_round':
      return `Call the lookup_code tool once with arguments exactly {"key":"ALPHA"}, then reply with exactly the returned code followed by this token: ${sentinel}`;
    default:
      return `Reply with exactly this token and nothing else: ${sentinel}`;
  }
}

function omoTrialArgs(fixture, seed) {
  return [
    '--mode',
    'json',
    '--print',
    '--offline',
    '--provider',
    'cursor',
    '--model',
    'composer-2.5',
    '--session-dir',
    fixture.sessionDir,
    '--extension',
    fixture.toolExtensionPath,
    '--no-extensions',
    '--no-builtin-tools',
    '--tools',
    'echo_value,lookup_code',
    '--name',
    `benchmark-${seed}`,
    '--no-approve',
    '--no-context-files',
  ];
}

function parseArgs(argv) {
  const out = {
    caseId: null,
    dryRun: false,
    captureDir: null,
    portA: DEFAULT_PORT_A,
    portB: DEFAULT_PORT_B,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    omoBin: null,
    cursorAgentBin: null,
    childApiEndpoint: null,
    authStorePath: null,
    modelStorePath: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--dry-run') {
      out.dryRun = true;
      continue;
    }
    if (!key.startsWith('--')) throw new NativeRunError('bad_args', `unexpected argument: ${key}`);
    const name = key.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new NativeRunError('bad_args', `missing value for --${name}`);
    }
    i += 1;
    switch (name) {
      case 'case':
        out.caseId = value;
        break;
      case 'capture-dir':
        out.captureDir = value;
        break;
      case 'port-a':
        out.portA = Number(value);
        break;
      case 'port-b':
        out.portB = Number(value);
        break;
      case 'timeout-ms':
        out.timeoutMs = Number(value);
        break;
      case 'omo-bin':
        out.omoBin = value;
        break;
      case 'cursor-agent-bin':
        out.cursorAgentBin = value;
        break;
      case 'child-api-endpoint':
        out.childApiEndpoint = value;
        break;
      case 'auth-store':
        out.authStorePath = value;
        break;
      case 'model-store':
        out.modelStorePath = value;
        break;
      default:
        throw new NativeRunError('bad_args', `unknown flag --${name}`);
    }
  }
  if (out.caseId === null) throw new NativeRunError('bad_args', 'missing --case');
  if (!CASE_IDS.includes(out.caseId)) {
    throw new NativeRunError('bad_args', `unsupported --case ${out.caseId}`);
  }
  assertPort(out.portA, 'port-a');
  assertPort(out.portB, 'port-b');
  if (out.portA === out.portB)
    throw new NativeRunError('bad_args', 'port-a and port-b must differ');
  if (!Number.isFinite(out.timeoutMs) || out.timeoutMs <= 0) {
    throw new NativeRunError('bad_args', 'timeout-ms must be a positive number');
  }
  return out;
}

function assertPort(port, label) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new NativeRunError('bad_args', `invalid --${label} ${port}`);
  }
  if (FORBIDDEN_PORTS.has(port)) {
    throw new NativeRunError('bad_args', `forbidden --${label} ${port}`);
  }
}

function resolveOnPath(name) {
  const pathValue = process.env.PATH ?? '';
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {
      /* try next */
    }
  }
  return null;
}

function resolveCursorAgent(explicit) {
  if (explicit) return path.resolve(explicit);
  return resolveOnPath('cursor-agent') ?? 'cursor-agent';
}

function resolveOmoBin(explicit) {
  if (explicit) return path.resolve(explicit);
  if (fs.existsSync(PINNED_OMO)) return PINNED_OMO;
  return resolveOnPath('omo') ?? 'omo';
}

function loadAuthToken(authStorePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(authStorePath, 'utf8'));
    const cursor =
      parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed.cursor
        : null;
    const access =
      cursor !== null && typeof cursor === 'object' && !Array.isArray(cursor)
        ? cursor.access
        : null;
    return typeof access === 'string' && access.length > 0 ? access : null;
  } catch {
    return null;
  }
}

function inheritedEnv() {
  const env = {};
  for (const name of ['PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL']) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

function buildNativeRunPlan(options) {
  const caseId = options.caseId;
  const pairIndex = 0;
  const sentinel = sentinelFor(caseId, SEED, pairIndex, LANE);
  const omoSeed = `${SEED}-${caseId}-${pairIndex}-${LANE}`;
  const captureDir = path.resolve(
    options.captureDir ?? path.join(os.tmpdir(), 'wire-capture-native', caseId),
  );
  const certsDir = path.join(captureDir, 'certs');
  const api2Dir = path.join(captureDir, 'api2');
  const agentnDir = path.join(captureDir, 'agentn');
  const fixtureDir = path.join(captureDir, 'fixture');
  const wrapperDir = path.join(captureDir, 'bin');
  const wrapperPath = path.join(wrapperDir, 'cursor-agent');
  const caCrt = path.join(certsDir, 'ca.crt');
  const leafCrt = path.join(certsDir, 'leaf.crt');
  const leafKey = path.join(certsDir, 'leaf.key');
  const portA = options.portA;
  const portB = options.portB;
  const apiEndpoint = options.childApiEndpoint ?? `https://127.0.0.1:${portA}`;
  const agentEndpoint = `https://127.0.0.1:${portB}`;
  const omoBin = resolveOmoBin(options.omoBin);
  const cursorAgentBin = resolveCursorAgent(options.cursorAgentBin);
  const sessionDir = path.join(fixtureDir, 'sessions');
  const toolExtensionPath = path.join(fixtureDir, 'benchmark-tools.mjs');
  const cwd = path.join(fixtureDir, 'workspace');
  const agentDir = path.join(fixtureDir, 'agent');
  const omoArgs = omoTrialArgs({ sessionDir, toolExtensionPath }, omoSeed);
  const omoEnv = {
    ...inheritedEnv(),
    NO_COLOR: '1',
    CURSOR_API_ENDPOINT: apiEndpoint,
    NODE_EXTRA_CA_CERTS: caCrt,
    WIRE_CAPTURE_API_ENDPOINT: apiEndpoint,
    WIRE_CAPTURE_AGENT_ENDPOINT: agentEndpoint,
    WIRE_CAPTURE_REAL_CURSOR_AGENT: cursorAgentBin,
    CURSOR_AGENT_EXECUTABLE: wrapperPath,
    SENPI_CURSOR_CLI_OAUTH_EXECUTABLE: wrapperPath,
    PATH: `${wrapperDir}${path.delimiter}${process.env.PATH ?? ''}`,
    OMO_CODING_AGENT_DIR: agentDir,
    SENPI_CODING_AGENT_DIR: agentDir,
    PI_CODING_AGENT_DIR: agentDir,
    OMO_LSP_DAEMON_DIR: path.join(fixtureDir, 'lsp-daemon'),
    OMO_BENCHMARK_SEED: omoSeed,
  };
  return {
    caseId,
    lane: LANE,
    seed: SEED,
    pairIndex,
    sentinel,
    omoSeed,
    prompt: promptFor(caseId, sentinel),
    timeoutMs: options.timeoutMs,
    cancelAfterFirstEvent: caseId === 'cancel_after_first_event',
    dryRun: options.dryRun,
    authStorePath: options.authStorePath ?? path.join(os.homedir(), '.omo/agent/auth.json'),
    modelStorePath:
      options.modelStorePath ?? path.join(os.homedir(), '.omo/agent/models-store.json'),
    dirs: {
      capture: captureDir,
      certs: certsDir,
      api2: api2Dir,
      agentn: agentnDir,
      fixture: fixtureDir,
      wrapper: wrapperDir,
    },
    ports: { api2: portA, agentn: portB },
    targets: { api2: TARGET_API2, agentn: TARGET_AGENTN },
    certs: {
      command: process.execPath,
      args: [GEN_CERTS_PATH, '--out', certsDir],
      out: certsDir,
      caCrt,
      leafCrt,
      leafKey,
    },
    proxies: [
      {
        name: 'api2',
        command: process.execPath,
        args: [
          PROXY_PATH,
          '--port',
          String(portA),
          '--target-host',
          TARGET_API2,
          '--cert',
          leafCrt,
          '--key',
          leafKey,
          '--capture-dir',
          api2Dir,
        ],
      },
      {
        name: 'agentn',
        command: process.execPath,
        args: [
          PROXY_PATH,
          '--port',
          String(portB),
          '--target-host',
          TARGET_AGENTN,
          '--cert',
          leafCrt,
          '--key',
          leafKey,
          '--capture-dir',
          agentnDir,
        ],
      },
    ],
    omo: {
      command: omoBin,
      args: omoArgs,
      cwd,
      env: omoEnv,
      stdin: 'prompt',
    },
    cursorAgent: {
      wrapperPath,
      realBin: cursorAgentBin,
      args: ['--endpoint', apiEndpoint, '--agent-endpoint', agentEndpoint],
      env: {
        CURSOR_API_ENDPOINT: apiEndpoint,
        NODE_EXTRA_CA_CERTS: caCrt,
        WIRE_CAPTURE_API_ENDPOINT: apiEndpoint,
        WIRE_CAPTURE_AGENT_ENDPOINT: agentEndpoint,
      },
    },
    execute: {
      command: cursorAgentBin,
      args: [
        '--print',
        '--output-format',
        'stream-json',
        '--trust',
        '--yolo',
        '--endpoint',
        apiEndpoint,
        '--agent-endpoint',
        agentEndpoint,
        '--model',
        'composer-2.5',
      ],
      cwd: path.join(captureDir, 'workspace'),
      env: {
        CURSOR_API_ENDPOINT: apiEndpoint,
        NODE_EXTRA_CA_CERTS: caCrt,
      },
      stdin: 'prompt',
    },
  };
}

function formatSpawnPlan(plan) {
  return `${JSON.stringify(
    {
      caseId: plan.caseId,
      lane: plan.lane,
      seed: plan.seed,
      pairIndex: plan.pairIndex,
      sentinel: plan.sentinel,
      omoSeed: plan.omoSeed,
      prompt: plan.prompt,
      timeoutMs: plan.timeoutMs,
      cancelAfterFirstEvent: plan.cancelAfterFirstEvent,
      dirs: plan.dirs,
      ports: plan.ports,
      targets: plan.targets,
      certs: {
        command: plan.certs.command,
        args: plan.certs.args,
        out: plan.certs.out,
        caCrt: plan.certs.caCrt,
        leafCrt: plan.certs.leafCrt,
        leafKey: plan.certs.leafKey,
      },
      proxies: plan.proxies,
      omo: {
        command: plan.omo.command,
        args: plan.omo.args,
        cwd: plan.omo.cwd,
        env: {
          CURSOR_API_ENDPOINT: plan.omo.env.CURSOR_API_ENDPOINT,
          NODE_EXTRA_CA_CERTS: plan.omo.env.NODE_EXTRA_CA_CERTS,
          WIRE_CAPTURE_AGENT_ENDPOINT: plan.omo.env.WIRE_CAPTURE_AGENT_ENDPOINT,
          CURSOR_AGENT_EXECUTABLE: plan.omo.env.CURSOR_AGENT_EXECUTABLE,
          PATH: plan.omo.env.PATH,
        },
        stdin: plan.prompt,
      },
      cursorAgent: plan.cursorAgent,
      execute: {
        command: plan.execute.command,
        args: plan.execute.args,
        cwd: plan.execute.cwd,
        env: plan.execute.env,
        stdin: plan.prompt,
      },
    },
    null,
    2,
  )}\n`;
}

function nonemptyNamed(dir, predicate) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => {
    if (!predicate(name)) return false;
    const full = path.join(dir, name);
    try {
      const st = fs.statSync(full);
      return st.isFile() && st.size > 0;
    } catch {
      return false;
    }
  });
}

function verifyCaptureCompleteness(plan) {
  const api2Bins = nonemptyNamed(plan.dirs.api2, (name) => name.endsWith('.bin'));
  const agentnBins = nonemptyNamed(plan.dirs.agentn, (name) => name.endsWith('.bin'));
  const api2Unary = nonemptyNamed(
    plan.dirs.api2,
    (name) => name.startsWith('unary-') && name.endsWith('.bin'),
  );
  const agentnRun = nonemptyNamed(plan.dirs.agentn, (name) => /^H2-\d+-req-\d+\.bin$/.test(name));
  const api2Life = nonemptyNamed(plan.dirs.api2, (name) => name === 'lifecycle.ndjson');
  const agentnLife = nonemptyNamed(plan.dirs.agentn, (name) => name === 'lifecycle.ndjson');
  const completeness = {
    api2_bin_count: api2Bins.length,
    agentn_bin_count: agentnBins.length,
    api2_unary_count: api2Unary.length,
    agentn_run_req_count: agentnRun.length,
    api2_lifecycle: api2Life.length > 0,
    agentn_lifecycle: agentnLife.length > 0,
    api2_files: api2Bins,
    agentn_files: agentnBins,
  };
  if (api2Bins.length === 0 && agentnBins.length === 0) {
    return { ok: false, reason: 'empty_capture', completeness };
  }
  if (api2Bins.length === 0) return { ok: false, reason: 'empty_capture_api2', completeness };
  if (agentnBins.length === 0) return { ok: false, reason: 'empty_capture_agentn', completeness };
  if (api2Unary.length === 0) return { ok: false, reason: 'missing_unary_api2', completeness };
  if (agentnRun.length === 0) return { ok: false, reason: 'missing_run_traffic', completeness };
  // api2 unary traffic is HTTP/1.1 and does not emit H2 lifecycle lines; Run (agentn) does.
  if (agentnLife.length === 0) return { ok: false, reason: 'empty_lifecycle_agentn', completeness };
  return { ok: true, reason: null, completeness };
}

function killTree(child, signal) {
  if (process.platform !== 'win32' && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      /* group may already be gone */
    }
  }
  try {
    child.kill(signal);
  } catch {
    /* already exited */
  }
}

function waitForListening(child, label, signal) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const fail = (error) => {
      cleanup();
      reject(error);
    };
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      if (buf.includes('listening on ')) {
        cleanup();
        resolve(buf);
      }
    };
    const onExit = (code, sig) => {
      fail(new NativeRunError('proxy_exited', `${label} exited before listening (${code}/${sig})`));
    };
    const onAbort = () => fail(new NativeRunError('timeout', `${label} listen wait aborted`));
    const cleanup = () => {
      child.stdout?.off('data', onData);
      child.off('exit', onExit);
      signal.removeEventListener('abort', onAbort);
    };
    child.stdout?.on('data', onData);
    child.once('exit', onExit);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function waitForClose(child, signal, options = {}) {
  const failOnError = options.failOnError === true;
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      child.off('close', onClose);
      child.off('error', onError);
      signal.removeEventListener('abort', onAbort);
      fn();
    };
    const onClose = (code, sig) => {
      finish(() => resolve({ code: code ?? child.exitCode, signal: sig ?? child.signalCode }));
    };
    const onError = (err) => {
      const code =
        err && typeof err === 'object' && 'code' in err && err.code != null
          ? String(err.code)
          : 'spawn_error';
      const message = err instanceof Error ? err.message : String(err);
      if (failOnError) {
        finish(() =>
          reject(new NativeRunError('spawn_error', `child spawn failed (${code}): ${message}`)),
        );
        return;
      }
      finish(() => resolve({ code: 1, signal: null }));
    };
    const onAbort = () => {
      killTree(child, 'SIGKILL');
    };
    child.once('close', onClose);
    child.once('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function asRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function nonemptyContent(value) {
  if (typeof value === 'string') return value.length > 0;
  return Array.isArray(value) && value.length > 0;
}

function isModelVisible(event) {
  const outer = asRecord(event);
  if (outer === null) return false;
  const nested = asRecord(outer.assistantMessageEvent) ?? outer;
  const type = typeof nested.type === 'string' ? nested.type : '';
  switch (type) {
    case 'text_delta':
      return nonemptyContent(nested.delta);
    case 'toolcall_start':
    case 'toolcall_delta':
    case 'toolcall_end':
    case 'assistant':
    case 'tool_call':
    case 'tool_use':
      return true;
    case 'message_end': {
      const message = asRecord(nested.message) ?? nested;
      if (message.role !== 'assistant') return false;
      if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return true;
      return nonemptyContent(message.content);
    }
    default:
      return false;
  }
}

function attachJsonl(child, onEvent) {
  let pending = '';
  const onData = (chunk) => {
    pending += chunk.toString('utf8');
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
      if (!trimmed.trim()) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed !== null && typeof parsed === 'object') onEvent(parsed);
      } catch {
        /* non-JSON diagnostic line */
      }
    }
  };
  child.stdout?.on('data', onData);
}

function writeAgentWrapper(wrapperPath, realBin) {
  fs.mkdirSync(path.dirname(wrapperPath), { recursive: true });
  const script = `#!/usr/bin/env node
import { spawn } from 'node:child_process';
const real = ${JSON.stringify(realBin)};
const api = process.env.WIRE_CAPTURE_API_ENDPOINT;
const agent = process.env.WIRE_CAPTURE_AGENT_ENDPOINT;
function strip(flag, shortFlag, argv) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === flag || token === shortFlag || token.startsWith(flag + '=')) {
      if ((token === flag || token === shortFlag) && argv[i + 1] && !argv[i + 1].startsWith('-')) {
        i += 1;
      }
      continue;
    }
    out.push(token);
  }
  return out;
}
let args = strip('--endpoint', '-e', process.argv.slice(2));
args = strip('--agent-endpoint', '', args);
if (agent) args.unshift('--agent-endpoint', agent);
if (api) args.unshift('--endpoint', api);
const child = spawn(real, args, { stdio: 'inherit', env: process.env });
child.on('error', (err) => {
  console.error(err);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
`;
  fs.writeFileSync(wrapperPath, script, { mode: 0o755 });
  fs.writeFileSync(path.join(path.dirname(wrapperPath), 'agent'), script, { mode: 0o755 });
}

function writeReceipt(plan, receipt) {
  fs.mkdirSync(plan.dirs.capture, { recursive: true });
  const dest = path.join(plan.dirs.capture, 'receipt.json');
  fs.writeFileSync(dest, `${JSON.stringify(receipt, null, 2)}\n`);
  return dest;
}

function spawnProxy(spawnFn, spec) {
  return spawnFn(spec.command, spec.args, {
    cwd: PROJECT_ROOT,
    env: inheritedEnv(),
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function runNativeCapture(options, deps = {}) {
  const plan = buildNativeRunPlan(options);
  if (options.dryRun) {
    return { ok: true, dryRun: true, plan, reason: null, receiptPath: null };
  }
  const spawnFn = deps.spawn ?? spawn;
  const generate = deps.generateCerts ?? generateCerts;
  const createFixture = deps.createFixture;
  const graceMs = deps.terminationGraceMs ?? TERMINATION_GRACE_MS;
  const startedAt = new Date().toISOString();
  const controller = new AbortController();
  const timeout = AbortSignal.timeout(plan.timeoutMs);
  const onTimeout = () => controller.abort();
  timeout.addEventListener('abort', onTimeout, { once: true });
  const children = [];
  let fixture = null;
  let omoExit = { code: null, signal: null };
  let spawnFailure = null;
  try {
    fs.mkdirSync(plan.dirs.api2, { recursive: true });
    fs.mkdirSync(plan.dirs.agentn, { recursive: true });
    fs.mkdirSync(plan.dirs.certs, { recursive: true });
    generate({ out: plan.dirs.certs });
    writeAgentWrapper(plan.cursorAgent.wrapperPath, plan.cursorAgent.realBin);

    for (const spec of plan.proxies) {
      const child = spawnProxy(spawnFn, spec);
      children.push(child);
      await waitForListening(child, spec.name, controller.signal);
    }

    if (createFixture) fixture = await createFixture(plan);
    fs.mkdirSync(plan.execute.cwd, { recursive: true });
    const childEnv = { ...inheritedEnv(), NO_COLOR: '1', ...plan.execute.env };
    const token = loadAuthToken(plan.authStorePath);
    if (token) childEnv.CURSOR_AUTH_TOKEN = token;
    const agent = spawnFn(plan.execute.command, plan.execute.args, {
      cwd: fixture?.cwd ?? plan.execute.cwd,
      env: childEnv,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.push(agent);
    const closed = waitForClose(agent, controller.signal, { failOnError: true });
    const appendCaptureLog = (name) => (chunk) => {
      try {
        fs.appendFileSync(path.join(plan.dirs.capture, name), chunk);
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'))
          throw error;
      }
    };
    agent.stdout?.on('data', appendCaptureLog('omo.stdout.log'));
    agent.stderr?.on('data', appendCaptureLog('omo.stderr.log'));
    if (plan.cancelAfterFirstEvent) {
      attachJsonl(agent, (event) => {
        if (isModelVisible(event)) killTree(agent, 'SIGTERM');
      });
    }
    if (controller.signal.aborted) killTree(agent, 'SIGTERM');
    else agent.stdin?.end(plan.prompt);
    omoExit = await closed;
  } catch (error) {
    if (error instanceof NativeRunError && error.reason === 'timeout') {
      omoExit = { code: null, signal: 'SIGKILL' };
    } else if (error instanceof NativeRunError && error.reason === 'spawn_error') {
      spawnFailure = error;
      omoExit = { code: 1, signal: null };
    } else if (!(error instanceof NativeRunError)) {
      throw error;
    } else if (error.reason !== 'proxy_exited') {
      throw error;
    }
  } finally {
    timeout.removeEventListener('abort', onTimeout);
    for (const child of children) killTree(child, 'SIGTERM');
    const killTimer = setTimeout(() => {
      for (const child of children) killTree(child, 'SIGKILL');
    }, graceMs);
    killTimer.unref?.();
    await Promise.all(
      children.map((child) => waitForClose(child, AbortSignal.timeout(graceMs + 200))),
    );
    clearTimeout(killTimer);
    if (fixture && typeof fixture.dispose === 'function') await fixture.dispose();
  }

  if (spawnFailure) {
    const receipt = {
      schema_version: 1,
      lane: plan.lane,
      case_id: plan.caseId,
      seed: plan.seed,
      pair_index: plan.pairIndex,
      sentinel: plan.sentinel,
      omo_seed: plan.omoSeed,
      ports: plan.ports,
      targets: plan.targets,
      capture_dir: plan.dirs.capture,
      certs_dir: plan.dirs.certs,
      omo_exit: omoExit,
      ok: false,
      reason: spawnFailure.reason,
      completeness: verifyCaptureCompleteness(plan).completeness,
      started_at: startedAt,
      ended_at: new Date().toISOString(),
    };
    writeReceipt(plan, receipt);
    throw spawnFailure;
  }

  const verified = verifyCaptureCompleteness(plan);
  const receipt = {
    schema_version: 1,
    lane: plan.lane,
    case_id: plan.caseId,
    seed: plan.seed,
    pair_index: plan.pairIndex,
    sentinel: plan.sentinel,
    omo_seed: plan.omoSeed,
    ports: plan.ports,
    targets: plan.targets,
    capture_dir: plan.dirs.capture,
    certs_dir: plan.dirs.certs,
    omo_exit: omoExit,
    ok: verified.ok,
    reason: verified.reason,
    completeness: verified.completeness,
    started_at: startedAt,
    ended_at: new Date().toISOString(),
  };
  const receiptPath = writeReceipt(plan, receipt);
  if (!verified.ok) {
    throw new NativeRunError(verified.reason, `capture incomplete: ${verified.reason}`);
  }
  return { ok: true, dryRun: false, plan, reason: null, receiptPath, receipt };
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.dryRun) {
    const plan = buildNativeRunPlan(options);
    process.stdout.write(formatSpawnPlan(plan));
    return 0;
  }
  try {
    const result = await runNativeCapture(options);
    if (result.receiptPath) process.stdout.write(`${result.receiptPath}\n`);
    return 0;
  } catch (error) {
    if (error instanceof NativeRunError) {
      process.stderr.write(`failure_reason=${error.reason}\n`);
      return error.reason === 'bad_args' ? 2 : 1;
    }
    throw error;
  }
}

if (isMain()) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exit(1);
    },
  );
}

export {
  CASE_IDS,
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
};
