#!/usr/bin/env node
/* global AbortSignal, Buffer, clearTimeout, fetch, process, setTimeout */
// Yorha-lane wire-capture runner: certs + proxy pair + local bridge + one F3 case.
// Configures the bridge purely by env (no src/ edits). Stall with complete captures is success.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generateCerts as generateCertsImpl } from './gen-certs.mjs';

const SEED = 20260818;
const LANE = 'yorha';
const CASE_IDS = ['tool_parallel_two', 'tool_sequential_two_round', 'cancel_after_first_event'];
const DEFAULT_PORT_A = 28443;
const DEFAULT_PORT_B = 28444;
const DEFAULT_BRIDGE_PORT = 9998;
const DEFAULT_TARGET_A = 'api2.cursor.sh';
const DEFAULT_TARGET_B = 'agentn.global.api5.cursor.sh';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_PROBE_TIMEOUT_MS = 15_000;
const DEFAULT_BOOT_TIMEOUT_MS = 30_000;
const LISTEN_PROXY = 'listening on https://';
const LISTEN_BRIDGE = 'cursor-ai-bridge listening on';
const OMO_REL = path.join(
  '.omo',
  'comparators',
  'omo-ai-5.0.0-0.beta.9',
  'node_modules',
  'omo-ai',
  'bin',
  'omo.js',
);

function scriptDir() {
  return path.dirname(fileURLToPath(import.meta.url));
}

function defaultProjectRoot() {
  return path.resolve(scriptDir(), '../..');
}

function parseArgs(argv) {
  const raw = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`);
    const name = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      raw[name] = true;
    } else {
      raw[name] = next;
      i += 1;
    }
  }
  const caseId = raw.case === true || raw.case === undefined ? 'tool_parallel_two' : raw.case;
  if (!CASE_IDS.includes(caseId)) {
    throw new Error(`unsupported --case ${caseId}; expected ${CASE_IDS.join('|')}`);
  }
  const numberFlag = (name, fallback) => {
    if (raw[name] === undefined || raw[name] === true) return fallback;
    const parsed = Number.parseInt(String(raw[name]), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`invalid --${name}`);
    return parsed;
  };
  return {
    case: caseId,
    dryRun: raw['dry-run'] === true,
    captureDir: typeof raw['capture-dir'] === 'string' ? raw['capture-dir'] : undefined,
    portA: numberFlag('port-a', DEFAULT_PORT_A),
    portB: numberFlag('port-b', DEFAULT_PORT_B),
    bridgePort: numberFlag('bridge-port', DEFAULT_BRIDGE_PORT),
    targetA: typeof raw['target-a'] === 'string' ? raw['target-a'] : DEFAULT_TARGET_A,
    targetB: typeof raw['target-b'] === 'string' ? raw['target-b'] : DEFAULT_TARGET_B,
    omoBin: typeof raw['omo-bin'] === 'string' ? raw['omo-bin'] : undefined,
    timeoutMs: numberFlag('timeout-ms', DEFAULT_TIMEOUT_MS),
    probeTimeoutMs: numberFlag('probe-timeout-ms', DEFAULT_PROBE_TIMEOUT_MS),
    bootTimeoutMs: numberFlag('boot-timeout-ms', DEFAULT_BOOT_TIMEOUT_MS),
  };
}

function sentinelFor(caseId, suiteSeed, pairIndex, lane) {
  const digest = createHash('sha256')
    .update(`${caseId}\u0000${suiteSeed}\u0000${pairIndex}\u0000${lane}`)
    .digest('hex')
    .slice(0, 12)
    .toUpperCase();
  return `BENCH_${caseId.toUpperCase()}_${lane.toUpperCase()}_${digest}`;
}

function buildTrialPrompt(caseId, sentinel) {
  if (caseId === 'tool_parallel_two') {
    return `Call the echo_value tool twice in the same turn with arguments exactly {"value":"${sentinel}"} and {"value":"${sentinel}_SECOND"}, then reply with exactly: DONE`;
  }
  if (caseId === 'tool_sequential_two_round') {
    return `Call the lookup_code tool once with arguments exactly {"key":"ALPHA"}, then reply with exactly the returned code followed by this token: ${sentinel}`;
  }
  return `Reply with exactly this token and nothing else: ${sentinel}`;
}

function stamp(now) {
  return now().toISOString().replace(/[:.]/g, '');
}

function resolveBridgeEntry(projectRoot, exists) {
  const dist = path.join(projectRoot, 'dist', 'index.js');
  if (exists(dist)) return { command: process.execPath, args: [dist] };
  const tsx = path.join(projectRoot, 'node_modules', '.bin', 'tsx');
  return { command: tsx, args: [path.join(projectRoot, 'src', 'index.ts')] };
}

function buildPlan(args, projectRoot, now = () => new Date()) {
  const captureDir = path.resolve(
    args.captureDir ??
      path.join(projectRoot, '.omo', 'evidence', 'wire-capture', 'yorha', args.case, stamp(now)),
  );
  const certsDir = path.join(captureDir, 'certs');
  const api2CaptureDir = path.join(captureDir, 'api2');
  const agentnCaptureDir = path.join(captureDir, 'agentn');
  const sentinel = sentinelFor(args.case, SEED, 0, LANE);
  const prompt = buildTrialPrompt(args.case, sentinel);
  const proxyScript = path.join(scriptDir(), 'proxy.mjs');
  const genCertsScript = path.join(scriptDir(), 'gen-certs.mjs');
  const leafCrt = path.join(certsDir, 'leaf.crt');
  const leafKey = path.join(certsDir, 'leaf.key');
  const caCrt = path.join(certsDir, 'ca.crt');
  const exists = fs.existsSync;
  const bridge = resolveBridgeEntry(projectRoot, exists);
  const omoBin = args.omoBin ?? path.join(projectRoot, OMO_REL);
  const omoArgs = [
    '--mode',
    'json',
    '--print',
    '--offline',
    '--provider',
    'yorha',
    '--model',
    'composer-2.5',
    '--session-dir',
    '<omo-fixture>/sessions',
    '--extension',
    '<omo-fixture>/benchmark-tools.mjs',
    '--no-extensions',
    '--no-builtin-tools',
    '--tools',
    'echo_value,lookup_code',
    '--name',
    `benchmark-${SEED}-${args.case}-0-${LANE}`,
    '--no-approve',
    '--no-context-files',
  ];
  return {
    caseId: args.case,
    lane: LANE,
    seed: SEED,
    pairIndex: 0,
    sentinel,
    prompt,
    omoSeed: `${SEED}-${args.case}-0-${LANE}`,
    projectRoot,
    captureDir,
    certsDir,
    api2CaptureDir,
    agentnCaptureDir,
    portA: args.portA,
    portB: args.portB,
    bridgePort: args.bridgePort,
    targetA: args.targetA,
    targetB: args.targetB,
    apiEndpoint: `https://127.0.0.1:${args.portA}`,
    agentEndpoint: `https://127.0.0.1:${args.portB}`,
    nodeExtraCaCerts: caCrt,
    genCertsArgs: [genCertsScript, '--out', certsDir],
    proxyAArgs: [
      proxyScript,
      '--port',
      String(args.portA),
      '--target-host',
      args.targetA,
      '--cert',
      leafCrt,
      '--key',
      leafKey,
      '--capture-dir',
      api2CaptureDir,
    ],
    proxyBArgs: [
      proxyScript,
      '--port',
      String(args.portB),
      '--target-host',
      args.targetB,
      '--cert',
      leafCrt,
      '--key',
      leafKey,
      '--capture-dir',
      agentnCaptureDir,
    ],
    bridgeCommand: bridge.command,
    bridgeArgs: bridge.args,
    bridgeEnvNames: [
      'CURSOR_BRIDGE_HOST',
      'CURSOR_BRIDGE_PORT',
      'CURSOR_BRIDGE_BACKEND',
      'CURSOR_BRIDGE_CURSOR_API_ENDPOINT',
      'CURSOR_BRIDGE_CURSOR_AGENT_ENDPOINT',
      'NODE_EXTRA_CA_CERTS',
      'CURSOR_API_KEY',
      'CURSOR_BRIDGE_API_KEY',
      'CURSOR_BRIDGE_AUTH',
    ],
    omoBin,
    omoArgs,
    probeUrl: `http://127.0.0.1:${args.bridgePort}/v1/models`,
    timeoutMs: args.timeoutMs,
    probeTimeoutMs: args.probeTimeoutMs,
    bootTimeoutMs: args.bootTimeoutMs,
  };
}

function formatPlan(plan, keyPresence = {}) {
  const present = (name) => (keyPresence[name] === false ? '<missing>' : '<from-env>');
  const lines = [
    'yorha-lane capture plan',
    `case: ${plan.caseId}`,
    `lane: ${plan.lane}`,
    `seed: ${plan.seed}`,
    `pair_index: ${plan.pairIndex}`,
    `sentinel: ${plan.sentinel}`,
    `prompt: ${plan.prompt}`,
    `capture_dir: ${plan.captureDir}`,
    `certs_dir: ${plan.certsDir}`,
    `gen_certs: ${process.execPath} ${plan.genCertsArgs.join(' ')}`,
    `proxy_a: ${process.execPath} ${plan.proxyAArgs.join(' ')}`,
    `proxy_b: ${process.execPath} ${plan.proxyBArgs.join(' ')}`,
    `bridge_command: ${plan.bridgeCommand} ${plan.bridgeArgs.join(' ')}`,
    `bridge_port: ${plan.bridgePort}`,
    'bridge_env:',
    '  CURSOR_BRIDGE_HOST=127.0.0.1',
    `  CURSOR_BRIDGE_PORT=${plan.bridgePort}`,
    '  CURSOR_BRIDGE_BACKEND=cursor-api',
    `  CURSOR_BRIDGE_CURSOR_API_ENDPOINT=${plan.apiEndpoint}`,
    `  CURSOR_BRIDGE_CURSOR_AGENT_ENDPOINT=${plan.agentEndpoint}`,
    `  NODE_EXTRA_CA_CERTS=${plan.nodeExtraCaCerts}`,
    `  CURSOR_API_KEY=${present('CURSOR_API_KEY')}`,
    `  CURSOR_BRIDGE_API_KEY=${present('CURSOR_BRIDGE_API_KEY')}`,
    '  CURSOR_BRIDGE_AUTH=on',
    `omo_bin: ${plan.omoBin}`,
    `omo_args: ${plan.omoArgs.join(' ')}`,
    'omo_provider: yorha',
    'omo_prompt_via: stdin',
    `probe: GET ${plan.probeUrl}`,
    `timeout_ms: ${plan.timeoutMs}`,
  ];
  return `${lines.join('\n')}\n`;
}

function parseEnvFile(contents) {
  const out = {};
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1);
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function loadDotEnv(projectRoot, readFile) {
  try {
    return parseEnvFile(readFile(path.join(projectRoot, '.env'), 'utf8'));
  } catch {
    return {};
  }
}

function mergeEnv(base, fileEnv, overrides) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(fileEnv)) {
    if (merged[key] === undefined) merged[key] = value;
  }
  return { ...merged, ...overrides };
}

function summarizeCaptureDir(dir) {
  const files = [];
  let bytes = 0;
  if (!fs.existsSync(dir)) return { files, bytes, complete: false };
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.bin')) continue;
    const full = path.join(dir, name);
    const info = fs.statSync(full);
    if (!info.isFile() || info.size <= 0) continue;
    files.push(name);
    bytes += info.size;
  }
  files.sort();
  return { files, bytes, complete: bytes > 0 };
}

function verifyCaptureCompleteness(api2Dir, agentnDir) {
  const api2 = summarizeCaptureDir(api2Dir);
  const agentn = summarizeCaptureDir(agentnDir);
  const gaps = [];
  if (!api2.complete) gaps.push('api2 capture empty (expected unary .bin frames)');
  if (!agentn.complete) gaps.push('agentn capture empty (expected Run .bin frames)');
  return { api2, agentn, complete: gaps.length === 0, gaps };
}

function signalTree(child, signal) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (process.platform !== 'win32' && typeof pid === 'number') {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Fake pids and already-reaped groups fall through to child.kill.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Concurrent exit is the desired state.
  }
}

function waitClose(child, ms) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('close timeout')), ms);
    timer.unref?.();
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once('close', done);
    child.once('error', done);
  });
}

function waitForNeedle(child, needle, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      if (buf.includes(needle)) {
        cleanup();
        resolve(buf);
      }
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(
        new Error(
          `${label} exited before ready (code=${code}, signal=${signal}): ${buf.slice(-800)}`,
        ),
      );
    };
    const onError = (error) => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `${label} exceeded ${timeoutMs}ms waiting for ${JSON.stringify(needle)}. output=${buf.slice(-800)}`,
        ),
      );
    }, timeoutMs);
    timer.unref?.();
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      child.stderr?.off('data', onData);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

async function defaultProbeBridge({ baseUrl, apiKey, timeoutMs }) {
  const response = await fetch(`${baseUrl}/v1/models`, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `bridge probe GET /v1/models failed: HTTP ${response.status} ${body.slice(0, 400)}`,
    );
  }
  return { status: response.status };
}

function toolExtensionSource() {
  return `export default function (pi) {
  pi.registerTool({
    name: "echo_value",
    label: "Echo value",
    description: "Return the supplied benchmark value unchanged.",
    parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
    async execute(_id, params) {
      return { content: [{ type: "text", text: params.value }], details: {} };
    },
  });
  pi.registerTool({
    name: "lookup_code",
    label: "Lookup code",
    description: "Return the deterministic benchmark code for ALPHA or BETA.",
    parameters: { type: "object", properties: { key: { type: "string", enum: ["ALPHA", "BETA"] } }, required: ["key"], additionalProperties: false },
    async execute(_id, params) {
      const codes = { ALPHA: "A-17", BETA: "B-23" };
      return { content: [{ type: "text", text: codes[params.key] }], details: {} };
    },
  });
}
`;
}

function providerDefinition(bridgeBaseUrl, apiKey) {
  return `${JSON.stringify(
    {
      providers: {
        yorha: {
          baseUrl: bridgeBaseUrl,
          api: 'openai-completions',
          apiKey,
          models: [
            {
              id: 'composer-2.5',
              name: 'Composer 2.5',
              upstreamModelId: 'composer-2.5',
              reasoning: false,
              input: ['text'],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 200000,
              maxTokens: 64000,
              compat: { supportsStore: false, supportsDeveloperRole: false },
            },
          ],
        },
      },
    },
    null,
    2,
  )}\n`;
}

function materializeOmoFixture(plan, apiKey, io) {
  const rootDir = io.mkdtemp(path.join(os.tmpdir(), 'wire-capture-yorha-omo-'));
  const cwd = path.join(rootDir, 'workspace');
  const agentDir = path.join(rootDir, 'agent');
  const sessionDir = path.join(rootDir, 'sessions');
  const onboardingDir = path.join(agentDir, 'omo-senpi', 'omo-native');
  const toolExtensionPath = path.join(rootDir, 'benchmark-tools.mjs');
  io.mkdir(cwd, { recursive: true });
  io.mkdir(agentDir, { recursive: true });
  io.mkdir(sessionDir, { recursive: true });
  io.mkdir(onboardingDir, { recursive: true });
  io.writeFile(path.join(cwd, 'fixture.txt'), 'alpha=17\nbeta=23\n', { mode: 0o600 });
  io.writeFile(
    path.join(agentDir, 'models.json'),
    providerDefinition(`http://127.0.0.1:${plan.bridgePort}/v1`, apiKey),
    { mode: 0o600 },
  );
  io.writeFile(toolExtensionPath, toolExtensionSource(), { mode: 0o600 });
  io.writeFile(path.join(onboardingDir, 'onboarding-completed'), '', { mode: 0o600 });
  return { rootDir, cwd, agentDir, sessionDir, toolExtensionPath };
}

function isModelVisibleEvent(parsed) {
  const nested =
    parsed.assistantMessageEvent !== null &&
    typeof parsed.assistantMessageEvent === 'object' &&
    !Array.isArray(parsed.assistantMessageEvent)
      ? parsed.assistantMessageEvent
      : null;
  const value = nested ?? parsed;
  const type = typeof value.type === 'string' ? value.type : '';
  if (type === 'text_delta') return typeof value.delta === 'string' && value.delta.length > 0;
  if (type === 'toolcall_start' || type === 'toolcall_delta' || type === 'toolcall_end')
    return true;
  if (type !== 'message_end') return false;
  const message =
    value.message !== null && typeof value.message === 'object' && !Array.isArray(value.message)
      ? value.message
      : value;
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return true;
  return typeof message.content === 'string' && message.content.length > 0;
}

function omoArgsForFixture(plan, fixture) {
  return plan.omoArgs.map((arg) => {
    if (arg === '<omo-fixture>/sessions') return fixture.sessionDir;
    if (arg === '<omo-fixture>/benchmark-tools.mjs') return fixture.toolExtensionPath;
    return arg;
  });
}

function emptyReceipt(plan, outcome, error) {
  return {
    schema_version: 1,
    lane: 'yorha',
    case_id: plan.caseId,
    sentinel: plan.sentinel,
    ports: { api2: plan.portA, agentn: plan.portB, bridge: plan.bridgePort },
    probe: { ok: false, status: null, error: error },
    captures: { api2: { files: [], bytes: 0 }, agentn: { files: [], bytes: 0 } },
    outcome,
    stall: outcome === 'stalled',
    error,
    omo_exit: null,
    omo_diagnostics: null,
  };
}

function writeReceipt(plan, receipt, writeFile) {
  writeFile(path.join(plan.captureDir, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
}

async function runOmoCase(plan, fixture, deps, env, children) {
  const args = omoArgsForFixture(plan, fixture);
  const child = deps.spawn(plan.omoBin, args, {
    cwd: fixture.cwd,
    env: {
      PATH: env.PATH,
      HOME: env.HOME,
      USERPROFILE: env.USERPROFILE,
      TMPDIR: env.TMPDIR,
      TMP: env.TMP,
      TEMP: env.TEMP,
      LANG: env.LANG,
      LC_ALL: env.LC_ALL,
      NO_COLOR: '1',
      OMO_CODING_AGENT_DIR: fixture.agentDir,
      SENPI_CODING_AGENT_DIR: fixture.agentDir,
      PI_CODING_AGENT_DIR: fixture.agentDir,
    },
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.add(child, 'omo');
  const spawnFailed = new Promise((_, reject) => {
    child.once('error', (err) => {
      const code =
        err && typeof err === 'object' && 'code' in err && err.code != null
          ? String(err.code)
          : 'SPAWN';
      const message = err instanceof Error ? err.message : String(err);
      reject(
        Object.assign(new Error(`omo spawn failed (${code}): ${message}`), {
          code: 'SPAWN_FAILED',
        }),
      );
    });
  });
  let pending = '';
  let firstEvent = false;
  let stdout = '';
  let stderr = '';
  const onStdout = (chunk) => {
    const text = chunk.toString('utf8');
    if (stdout.length < 8_000) stdout += text.slice(0, 8_000 - stdout.length);
    pending += text;
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === 'object' && isModelVisibleEvent(parsed)) {
          firstEvent = true;
          if (plan.caseId === 'cancel_after_first_event') signalTree(child, 'SIGTERM');
        }
      } catch {
        // Non-JSON diagnostic lines are ignored; capture completeness is the gate.
      }
    }
  };
  child.stdout?.on('data', onStdout);
  child.stderr?.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    if (stderr.length < 8_000) stderr += text.slice(0, 8_000 - stderr.length);
  });
  const closed = new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  child.stdin?.end(plan.prompt);
  const timeout = new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), plan.timeoutMs);
    timer.unref?.();
    closed.then(() => clearTimeout(timer));
  });
  const winner = await Promise.race([
    closed.then((exit) => ({ kind: 'exit', exit })),
    timeout.then((value) => ({ kind: value })),
    spawnFailed,
  ]);
  if (winner.kind === 'timeout') {
    signalTree(child, 'SIGTERM');
    try {
      await waitClose(child, 8_000);
    } catch {
      signalTree(child, 'SIGKILL');
      await waitClose(child, 2_000).catch(() => undefined);
    }
    return { stalled: true, exit: { code: null, signal: 'SIGTERM' }, firstEvent, stdout, stderr };
  }
  return { stalled: false, exit: winner.exit, firstEvent, stdout, stderr };
}

async function runYorhaCapture(args, deps = {}) {
  const projectRoot = defaultProjectRoot();
  const io = {
    mkdir: deps.mkdir ?? fs.mkdirSync,
    writeFile: deps.writeFile ?? fs.writeFileSync,
    readFile: deps.readFile ?? fs.readFileSync,
    exists: deps.exists ?? fs.existsSync,
    readdir: deps.readdir ?? fs.readdirSync,
    stat: deps.stat ?? fs.statSync,
    rm: deps.rm ?? fs.rmSync,
    mkdtemp: deps.mkdtemp ?? fs.mkdtempSync,
  };
  const plan = buildPlan(args, projectRoot, deps.now);
  const fileEnv = deps.env ? {} : loadDotEnv(projectRoot, io.readFile);
  const baseEnv = deps.env ?? process.env;
  const keyPresence = {
    CURSOR_API_KEY: Boolean(baseEnv.CURSOR_API_KEY ?? fileEnv.CURSOR_API_KEY),
    CURSOR_BRIDGE_API_KEY: Boolean(baseEnv.CURSOR_BRIDGE_API_KEY ?? fileEnv.CURSOR_BRIDGE_API_KEY),
  };
  if (args.dryRun) {
    const stdout = formatPlan(plan, keyPresence);
    return {
      exitCode: 0,
      outcome: 'dry_run',
      receipt: emptyReceipt(plan, 'dry_run', null),
      plan,
      stdout,
    };
  }

  const spawnChild =
    deps.spawn ?? ((command, spawnArgs, options) => spawn(command, [...spawnArgs], options));
  const generateCerts = deps.generateCerts ?? generateCertsImpl;
  const probeBridge = deps.probeBridge ?? defaultProbeBridge;
  const env = mergeEnv(baseEnv, fileEnv, {});
  const apiKey = env.CURSOR_API_KEY;
  const bridgeKey = env.CURSOR_BRIDGE_API_KEY;
  const children = {
    items: [],
    add(child, role) {
      this.items.push({ child, role });
      return child;
    },
    async shutdown() {
      for (const item of this.items) signalTree(item.child, 'SIGTERM');
      await Promise.all(
        this.items.map((item) =>
          waitClose(item.child, 8_000).catch(() => {
            signalTree(item.child, 'SIGKILL');
            return waitClose(item.child, 2_000).catch(() => undefined);
          }),
        ),
      );
    },
  };

  io.mkdir(plan.captureDir, { recursive: true });
  io.mkdir(plan.certsDir, { recursive: true });
  io.mkdir(plan.api2CaptureDir, { recursive: true });
  io.mkdir(plan.agentnCaptureDir, { recursive: true });

  let fixture = null;
  let outcome = 'boot_failed';
  let error = null;
  let probe = { ok: false, status: null, error: null };
  let omoExit = null;
  let omoDiagnostics = null;
  const localSpawn = (command, spawnArgs, options) => spawnChild(command, spawnArgs, options);

  try {
    if (!apiKey || !bridgeKey) {
      throw new Error(
        'missing CURSOR_API_KEY or CURSOR_BRIDGE_API_KEY (names only; values not printed)',
      );
    }
    generateCerts({ out: plan.certsDir });
    const proxyEnv = mergeEnv(env, {}, { NO_COLOR: '1' });
    const proxyA = localSpawn(process.execPath, plan.proxyAArgs, {
      cwd: projectRoot,
      env: proxyEnv,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.add(proxyA, 'proxy-a');
    const proxyB = localSpawn(process.execPath, plan.proxyBArgs, {
      cwd: projectRoot,
      env: proxyEnv,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.add(proxyB, 'proxy-b');
    await Promise.all([
      waitForNeedle(proxyA, LISTEN_PROXY, 10_000, 'api2 proxy'),
      waitForNeedle(proxyB, LISTEN_PROXY, 10_000, 'agentn proxy'),
    ]);

    const bridgeEnv = mergeEnv(
      env,
      {},
      {
        CURSOR_BRIDGE_HOST: '127.0.0.1',
        CURSOR_BRIDGE_PORT: String(plan.bridgePort),
        CURSOR_BRIDGE_BACKEND: 'cursor-api',
        CURSOR_BRIDGE_CURSOR_API_ENDPOINT: plan.apiEndpoint,
        CURSOR_BRIDGE_CURSOR_AGENT_ENDPOINT: plan.agentEndpoint,
        NODE_EXTRA_CA_CERTS: plan.nodeExtraCaCerts,
        CURSOR_BRIDGE_AUTH: 'on',
        CURSOR_BRIDGE_API_KEY: bridgeKey,
        CURSOR_API_KEY: apiKey,
        CURSOR_BRIDGE_AUTO_PROBE_TIMEOUT_MS: String(plan.bootTimeoutMs),
        NO_COLOR: '1',
      },
    );
    const bridge = localSpawn(plan.bridgeCommand, plan.bridgeArgs, {
      cwd: projectRoot,
      env: bridgeEnv,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.add(bridge, 'bridge');
    try {
      await waitForNeedle(bridge, LISTEN_BRIDGE, plan.bootTimeoutMs, 'bridge');
    } catch (bootError) {
      const message = bootError instanceof Error ? bootError.message : String(bootError);
      outcome = 'probe_failed';
      error = `bridge probe failed against the proxy: ${message}`;
      probe = { ok: false, status: null, error };
      throw Object.assign(new Error(error), { code: 'PROBE_FAILED' });
    }

    try {
      const probed = await probeBridge({
        baseUrl: `http://127.0.0.1:${plan.bridgePort}`,
        apiKey: bridgeKey,
        timeoutMs: plan.probeTimeoutMs,
      });
      probe = { ok: true, status: probed.status, error: null };
    } catch (probeError) {
      const message = probeError instanceof Error ? probeError.message : String(probeError);
      outcome = 'probe_failed';
      error = `bridge probe failed against the proxy: ${message}`;
      probe = { ok: false, status: null, error };
      throw Object.assign(new Error(error), { code: 'PROBE_FAILED' });
    }

    fixture = materializeOmoFixture(plan, bridgeKey, io);
    const omo = await runOmoCase(plan, fixture, { spawn: localSpawn }, env, children);
    omoExit = omo.exit;
    omoDiagnostics = {
      stdout_bytes: Buffer.byteLength(omo.stdout),
      stderr_bytes: Buffer.byteLength(omo.stderr),
      first_visible_event: omo.firstEvent,
    };
    const captures = verifyCaptureCompleteness(plan.api2CaptureDir, plan.agentnCaptureDir);
    if (!captures.complete) {
      outcome = 'incomplete_capture';
      error = captures.gaps.join('; ');
    } else if (omo.stalled) {
      outcome = 'stalled';
      error = null;
    } else {
      outcome = 'completed';
      error = null;
    }
  } catch (caught) {
    if (outcome !== 'probe_failed') {
      outcome = 'boot_failed';
      error = caught instanceof Error ? caught.message : String(caught);
    }
  } finally {
    await children.shutdown();
    if (fixture) {
      try {
        io.rm(fixture.rootDir, { recursive: true, force: true });
      } catch {
        // Temp fixture cleanup is best-effort after process teardown.
      }
    }
  }

  const captures = verifyCaptureCompleteness(plan.api2CaptureDir, plan.agentnCaptureDir);
  if ((outcome === 'completed' || outcome === 'stalled') && !captures.complete) {
    outcome = 'incomplete_capture';
    error = captures.gaps.join('; ');
  }
  const receipt = {
    schema_version: 1,
    lane: 'yorha',
    case_id: plan.caseId,
    sentinel: plan.sentinel,
    ports: { api2: plan.portA, agentn: plan.portB, bridge: plan.bridgePort },
    probe,
    captures: {
      api2: { files: captures.api2.files, bytes: captures.api2.bytes },
      agentn: { files: captures.agentn.files, bytes: captures.agentn.bytes },
    },
    outcome,
    stall: outcome === 'stalled',
    error,
    omo_exit: omoExit,
    omo_diagnostics: omoDiagnostics,
  };
  writeReceipt(plan, receipt, io.writeFile);
  const exitCode = outcome === 'completed' || outcome === 'stalled' ? 0 : 1;
  const stdout = `${formatPlan(plan, keyPresence)}outcome: ${outcome}\nreceipt: ${path.join(plan.captureDir, 'receipt.json')}\n`;
  return { exitCode, outcome, receipt, plan, stdout };
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const args = parseArgs(argv);
  const result = await runYorhaCapture(args, deps);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.exitCode !== 0 && result.receipt.error) {
    process.stderr.write(`${result.receipt.error}\n`);
  }
  return result.exitCode;
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isMain()) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exit(1);
    },
  );
}

export {
  CASE_IDS,
  DEFAULT_BRIDGE_PORT,
  DEFAULT_PORT_A,
  DEFAULT_PORT_B,
  LANE,
  SEED,
  buildPlan,
  buildTrialPrompt,
  formatPlan,
  main,
  parseArgs,
  runYorhaCapture,
  sentinelFor,
  summarizeCaptureDir,
  verifyCaptureCompleteness,
};
