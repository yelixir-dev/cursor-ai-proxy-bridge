import { existsSync, readdirSync } from 'node:fs';
import { chmod, lstat, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCanonicalCases, sentinelFor } from '../src/benchmark/cases.js';
import { makeExecutor } from '../src/benchmark/executor.js';
import { AuthStoreError, sanitizeAuthContents } from '../src/benchmark/fixture-auth.js';
import { createBenchmarkFixture } from '../src/benchmark/fixture.js';
import { BridgeTraceCollector } from '../src/benchmark/bridge-trace.js';
import { sha256Hex } from '../src/benchmark/normalize.js';
import { runOmoTrial, type OmoSpawn } from '../src/benchmark/omo-process.js';
import { buildTrialPrompt, expectedCallsFor } from '../src/benchmark/schedule.js';
import {
  assembleTrialRecord,
  type LaneTrialRequest,
  type LaneTrialSample,
} from '../src/benchmark/trial-record.js';

const VERSION = 'omo 5.0.0-0.beta.9 (engine: senpi 2026.8.17)\n';
const MODELS = 'cursor composer-2.5 200K 64K no no\n';
const AUTH_401 =
  '401: {"type":"authentication_error","message":"Missing or invalid Cursor Bridge client API key"}';

const roots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 71_001;

  kill(): boolean {
    return true;
  }

  close(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }
}

function fakeSpawn(
  onSpawn: (child: FakeChild, args: readonly string[], options: SpawnOptions) => void,
): OmoSpawn {
  return (_command, args, options) => {
    const child = new FakeChild();
    onSpawn(child, args, options);
    return child as unknown as ChildProcess;
  };
}

function inspection() {
  return vi.fn(async (_command: string, args: readonly string[]) =>
    args.includes('--version') ? VERSION : MODELS,
  );
}

const CURSOR_OAUTH = {
  type: 'oauth' as const,
  access: 'cursor-native-access-token',
  refresh: 'cursor-native-refresh-token',
  expires: 4_102_444_800,
};
const DISPOSABLE_AUTH = `${JSON.stringify(
  {
    cursor: CURSOR_OAUTH,
    'kimi-coding': { access: 'kimi-access', expires: 1, refresh: 'kimi-refresh', type: 'oauth' },
    yorha: { key: 'yorha-conflicting-stored-key-1234567890', type: 'api_key' },
  },
  null,
  2,
)}\n`;
const SECRET_SENTINEL = 'R5_CREDENTIAL_VALUE_MUST_NOT_APPEAR';
const authWith = (cursor: unknown): string =>
  JSON.stringify({ cursor, yorha: { type: 'api_key', key: 'collision' } });
const INVALID_AUTH_STORES = [
  ['invalid JSON', '{not-json\n'],
  ['top-level scalar', '42'],
  ['top-level null', 'null'],
  ['top-level array', '[]'],
  ['missing cursor', JSON.stringify({ yorha: { type: 'api_key', key: 'collision' } })],
  ['cursor scalar', authWith(42)],
  ['cursor null', authWith(null)],
  ['cursor array', authWith([])],
  ['cursor missing type', authWith({ access: SECRET_SENTINEL, refresh: 'refresh', expires: 1 })],
  [
    'cursor blank type',
    authWith({ type: ' ', access: SECRET_SENTINEL, refresh: 'refresh', expires: 1 }),
  ],
  ['cursor known but unsupported api_key', authWith({ type: 'api_key', key: SECRET_SENTINEL })],
  ['cursor unknown type', authWith({ type: 'future_auth', value: SECRET_SENTINEL })],
  ['cursor missing access', authWith({ type: 'oauth', refresh: 'refresh', expires: 1 })],
  [
    'cursor blank access',
    authWith({ type: 'oauth', access: '  ', refresh: 'refresh', expires: 1 }),
  ],
  [
    'cursor oversized access',
    authWith({ type: 'oauth', access: 'a'.repeat(65_537), refresh: 'refresh', expires: 1 }),
  ],
  [
    'cursor non-string access',
    authWith({ type: 'oauth', access: 7, refresh: 'refresh', expires: 1 }),
  ],
  ['cursor missing refresh', authWith({ type: 'oauth', access: SECRET_SENTINEL, expires: 1 })],
  [
    'cursor blank refresh',
    authWith({ type: 'oauth', access: SECRET_SENTINEL, refresh: '\t', expires: 1 }),
  ],
  [
    'cursor oversized refresh',
    authWith({ type: 'oauth', access: SECRET_SENTINEL, refresh: 'r'.repeat(65_537), expires: 1 }),
  ],
  [
    'cursor non-string refresh',
    authWith({ type: 'oauth', access: SECRET_SENTINEL, refresh: false, expires: 1 }),
  ],
  [
    'cursor missing expires',
    authWith({ type: 'oauth', access: SECRET_SENTINEL, refresh: 'refresh' }),
  ],
  [
    'cursor string expires',
    authWith({ type: 'oauth', access: SECRET_SENTINEL, refresh: 'refresh', expires: '1' }),
  ],
  [
    'cursor negative expires',
    authWith({ type: 'oauth', access: SECRET_SENTINEL, refresh: 'refresh', expires: -1 }),
  ],
  [
    'cursor fractional expires',
    authWith({ type: 'oauth', access: SECRET_SENTINEL, refresh: 'refresh', expires: 1.5 }),
  ],
  [
    'cursor unsafe expires',
    authWith({
      type: 'oauth',
      access: SECRET_SENTINEL,
      refresh: 'refresh',
      expires: Number.MAX_SAFE_INTEGER + 1,
    }),
  ],
] as const;

async function disposableStores() {
  const root = await mkdtemp(join(tmpdir(), 'benchmark-fixture-child-'));
  roots.push(root);
  const authStorePath = join(root, 'auth.json');
  const modelStorePath = join(root, 'models-store.json');
  await writeFile(authStorePath, DISPOSABLE_AUTH, { mode: 0o600 });
  await writeFile(
    modelStorePath,
    `${JSON.stringify({
      cursor: {
        models: [
          { id: 'composer-2.5', name: 'Composer 2.5', api: 'cursor-agent', provider: 'cursor' },
        ],
      },
    })}\n`,
    { mode: 0o600 },
  );
  return { root, authStorePath, modelStorePath };
}

describe('sanitized fixture auth isolation', () => {
  it('writes a private minimal cursor-only auth copy', async () => {
    const { root, authStorePath, modelStorePath } = await disposableStores();
    const sourceStat = await stat(authStorePath);
    const fixture = await createBenchmarkFixture({
      authStorePath,
      modelStorePath,
      bridgeBaseUrl: 'http://127.0.0.1:9911/v1',
      tempRoot: root,
    });
    const copyPath = join(fixture.agentDir, 'auth.json');
    expect((await lstat(copyPath)).isSymbolicLink()).toBe(false);
    const copy = JSON.parse(await readFile(copyPath, 'utf8')) as Record<string, unknown>;
    expect(copy).toEqual({ cursor: CURSOR_OAUTH });
    expect(Object.keys(copy)).toEqual(['cursor']);
    expect((await stat(copyPath)).mode & 0o077).toBe(0);
    expect(await readFile(authStorePath, 'utf8')).toBe(DISPOSABLE_AUTH);
    const after = await stat(authStorePath);
    expect(after.mtimeMs).toBe(sourceStat.mtimeMs);
    expect(after.size).toBe(sourceStat.size);
    expect(fixture.redactions).toContain('yorha-conflicting-stored-key-1234567890');
    expect(fixture.redactions).toContain('cursor-native-access-token');
    await fixture.dispose();
  });

  it.each(INVALID_AUTH_STORES)(
    'fails explicitly on %s auth before comparator or child launch',
    async (_kind, contents) => {
      const { root, authStorePath, modelStorePath } = await disposableStores();
      await writeFile(authStorePath, contents);
      const sourceStat = await stat(authStorePath);
      const sourceHash = sha256Hex(contents);
      const fixtureError = await createBenchmarkFixture({
        authStorePath,
        modelStorePath,
        bridgeBaseUrl: 'http://127.0.0.1:9911/v1',
        tempRoot: root,
      }).catch((error: unknown) => error);
      expect(fixtureError).toBeInstanceOf(AuthStoreError);
      expect(String(fixtureError)).not.toContain(SECRET_SENTINEL);
      expect(await readFile(authStorePath, 'utf8')).toBe(contents);
      const spawn = vi.fn<OmoSpawn>();
      const commandOutput = inspection();
      const processError = await runOmoTrial(
        {
          provider: 'yorha',
          model: 'composer-2.5',
          prompt: 'p',
          seed: 'seed-auth',
          command: '/task-owned/comparator/omo',
          authStorePath,
          modelStorePath,
          bridgeBaseUrl: 'http://127.0.0.1:9911/v1',
          timeoutMs: 1_000,
          tempRoot: root,
        },
        { spawn, commandOutput },
      ).catch((error: unknown) => error);
      expect(processError).toMatchObject({ failureClass: 'harness_failure' });
      expect(String(processError)).not.toContain(SECRET_SENTINEL);
      expect(commandOutput).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
      const sourceAfter = await readFile(authStorePath, 'utf8');
      const sourceStatAfter = await stat(authStorePath);
      expect(sha256Hex(sourceAfter)).toBe(sourceHash);
      expect(sourceStatAfter.mtimeMs).toBe(sourceStat.mtimeMs);
      expect(
        readdirSync(root).filter((entry) => entry.startsWith('cursor-composer-benchmark-')),
      ).toEqual([]);
    },
  );

  it.each([
    ['seconds expiry', CURSOR_OAUTH],
    [
      'milliseconds expiry with runtime extension fields',
      {
        ...CURSOR_OAUTH,
        expires: 4_102_444_800_000,
        accountLabel: 'ignored-account-label',
        nestedExtensionState: { ignored: true },
      },
    ],
  ] as const)('parses supported cursor OAuth variant: %s', (_name, credential) => {
    const sanitized = JSON.parse(
      sanitizeAuthContents(
        JSON.stringify({
          cursor: credential,
          yorha: { type: 'api_key', key: 'collision' },
          'kimi-coding': { type: 'oauth', access: 'other', refresh: 'other', expires: 1 },
        }),
      ),
    );
    expect(sanitized).toEqual({
      cursor: {
        type: 'oauth',
        access: credential.access,
        refresh: credential.refresh,
        expires: credential.expires,
      },
    });
  });

  it('preseeds the OMO onboarding-completed state in every fresh fixture agent dir', async () => {
    const { root, authStorePath, modelStorePath } = await disposableStores();
    const first = await createBenchmarkFixture({
      authStorePath,
      modelStorePath,
      bridgeBaseUrl: 'http://127.0.0.1:9911/v1',
      tempRoot: root,
    });
    const second = await createBenchmarkFixture({
      authStorePath,
      modelStorePath,
      bridgeBaseUrl: 'http://127.0.0.1:9911/v1',
      tempRoot: root,
    });
    for (const fixture of [first, second]) {
      expect(
        existsSync(join(fixture.agentDir, 'omo-senpi', 'omo-native', 'onboarding-completed')),
      ).toBe(true);
      const copy = JSON.parse(await readFile(join(fixture.agentDir, 'auth.json'), 'utf8'));
      expect(copy.cursor).toBeDefined();
      expect(copy.yorha).toBeUndefined();
    }
    await Promise.all([first.dispose(), second.dispose()]);
  });
});

describe('sanitized session transcript summary', () => {
  it('retains only a bounded histogram before fixture disposal', async () => {
    const { root, authStorePath, modelStorePath } = await disposableStores();
    const prompt = 'fixture prompt with sentinel text';
    let sessionDir = '';
    const spawn = fakeSpawn((child, args) => {
      sessionDir = String(args[args.indexOf('--session-dir') + 1]);
      child.stdin.once('finish', () => {
        void writeFile(
          join(sessionDir, 'session.jsonl'),
          [
            JSON.stringify({ kind: 'session' }),
            JSON.stringify({ kind: 'custom', customType: 'omo-onboarding:bootstrap' }),
            JSON.stringify({ kind: 'message', message: { role: 'user', content: prompt } }),
            JSON.stringify({
              kind: 'message',
              message: {
                role: 'assistant',
                content: '',
                stopReason: 'error',
                errorMessage: AUTH_401,
              },
            }),
            JSON.stringify({
              kind: 'message',
              message: { role: 'assistant', content: 'ok', stopReason: 'stop' },
            }),
          ].join('\n') + '\n',
        ).then(() => {
          child.stdout.write(
            '{"type":"message_end","message":{"role":"assistant","content":"ok","stopReason":"stop"}}\n',
          );
          child.stderr.write('synthetic stderr diagnostic\n');
          child.close(0);
        });
      });
    });
    const result = await runOmoTrial(
      {
        provider: 'yorha',
        model: 'composer-2.5',
        prompt,
        seed: 'seed-summary',
        command: '/task-owned/comparator/omo',
        authStorePath,
        modelStorePath,
        bridgeBaseUrl: 'http://127.0.0.1:9911/v1',
        timeoutMs: 1_000,
        tempRoot: root,
      },
      { spawn, commandOutput: inspection() },
    );
    expect(result.session).toEqual({
      entry_kinds: { session: 1, custom: 1, message: 3 },
      assistant_stop_reasons: { error: 1, stop: 1 },
      errored_assistant_messages: 1,
      user_messages: 1,
    });
    expect(JSON.stringify(result.session)).not.toContain(prompt);
    expect(JSON.stringify(result.session)).not.toContain('authentication_error');
    expect(result.diagnostics).toContain('synthetic stderr diagnostic');
    expect(result.exit).toEqual({ code: 0, signal: null });
  });

  it('attaches the summary to OmoProcessError details before disposal', async () => {
    const { root, authStorePath, modelStorePath } = await disposableStores();
    let sessionDir = '';
    const spawn = fakeSpawn((child, args) => {
      sessionDir = String(args[args.indexOf('--session-dir') + 1]);
      child.stdin.once('finish', () => {
        void writeFile(
          join(sessionDir, 'session.jsonl'),
          `${JSON.stringify({ kind: 'message', message: { role: 'user', content: 'p' } })}\n`,
        ).then(() => {
          child.stdout.write('{"type":"agent_start"}\n');
          child.close(9);
        });
      });
    });
    const error = await runOmoTrial(
      {
        provider: 'yorha',
        model: 'composer-2.5',
        prompt: 'p',
        seed: 'seed-error-summary',
        command: '/task-owned/comparator/omo',
        authStorePath,
        modelStorePath,
        bridgeBaseUrl: 'http://127.0.0.1:9911/v1',
        timeoutMs: 1_000,
        tempRoot: root,
      },
      { spawn, commandOutput: inspection() },
    ).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ failureClass: 'early_exit' });
    expect(
      error && typeof error === 'object' && 'details' in error
        ? (error as { details?: { session?: unknown } }).details?.session
        : undefined,
    ).toMatchObject({ user_messages: 1, errored_assistant_messages: 0 });
  });
});

function requestFor(
  caseId: 'text_sentinel_stream' | 'tool_auto_single',
  lane: 'native' | 'yorha',
): LaneTrialRequest {
  const testCase = createCanonicalCases().find((candidate) => candidate.id === caseId);
  if (!testCase) throw new Error(`missing case ${caseId}`);
  const sentinel = sentinelFor(caseId, 20260818, 0, lane);
  const prompt = buildTrialPrompt(testCase, sentinel);
  return {
    testCase,
    pairIndex: 0,
    phase: 'measured',
    lane,
    sentinel,
    peerSentinels: [],
    prompt,
    promptHash: sha256Hex(prompt),
    expectedCalls: expectedCallsFor(testCase, sentinel),
    omoSeed: '20260818-seed',
    concurrency: 1,
    signal: new AbortController().signal,
  };
}

const EMPTY_JOIN = {
  sequence_start: null,
  sequence_end: null,
  request_ids: [],
  record_count: 0,
  attributed_run_count: 0,
  synchronized: true,
};

function onboardingOnlyRawEvents(): unknown[] {
  return [
    { type: 'agent_start', atMs: 0 },
    { type: 'message_end', atMs: 5, message: { role: 'custom', content: 'X'.repeat(191) } },
    {
      type: 'message_end',
      atMs: 10,
      message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: AUTH_401 },
    },
    { type: 'agent_end', atMs: 15 },
  ];
}

function sampleFor(
  rawEvents: unknown[],
  overrides: Partial<LaneTrialSample> = {},
): LaneTrialSample {
  return {
    rawEvents,
    durationMs: 15,
    upstreamRuns: 0,
    failureClass: null,
    promptHash: null,
    httpStatus: null,
    isolatedSentinels: null,
    traceJoin: null,
    childReport: { diagnostics: '', exits: [{ code: 0, signal: null }], session: null },
    ...overrides,
  };
}

describe('errored assistant turn authority', () => {
  it('classifies the exact 191-char onboarding-only 401 signature as auth, not a completed run', () => {
    const request = requestFor('text_sentinel_stream', 'yorha');
    const record = assembleTrialRecord(
      request,
      sampleFor(onboardingOnlyRawEvents(), { traceJoin: EMPTY_JOIN }),
    );
    expect(record.passed).toBe(false);
    expect(record.failure_class).toBe('auth');
    expect(record.owning_layer).toBe('infrastructure');
    expect(record.events.at(-1)).toMatchObject({ type: 'terminal', reason: 'error' });
  });

  it('does not rely on the zero-Run guard or the lane', () => {
    const validJoin = {
      sequence_start: 1,
      sequence_end: 2,
      request_ids: ['req-auth-1'],
      record_count: 2,
      attributed_run_count: 1,
      synchronized: true,
    };
    const withRuns = assembleTrialRecord(
      requestFor('text_sentinel_stream', 'yorha'),
      sampleFor(onboardingOnlyRawEvents(), { upstreamRuns: 1, traceJoin: validJoin }),
    );
    expect(withRuns.failure_class).toBe('auth');
    const native = assembleTrialRecord(
      requestFor('text_sentinel_stream', 'native'),
      sampleFor(onboardingOnlyRawEvents()),
    );
    expect(native.failure_class).toBe('auth');

    const sessionOnly = assembleTrialRecord(
      requestFor('text_sentinel_stream', 'native'),
      sampleFor(
        [
          { type: 'agent_start', atMs: 0 },
          { type: 'agent_end', atMs: 10 },
        ],
        {
          childReport: {
            diagnostics: '',
            exits: [{ code: 0, signal: null }],
            session: {
              entry_kinds: { message: 2 },
              assistant_stop_reasons: { error: 1 },
              errored_assistant_messages: 1,
              user_messages: 1,
            },
          },
        },
      ),
    );
    expect(sessionOnly.failure_class).toBe('transport');
  });

  it('separates non-auth provider errors and honors diagnostics-only signatures', () => {
    const upstream = assembleTrialRecord(
      requestFor('text_sentinel_stream', 'yorha'),
      sampleFor(
        [
          { type: 'agent_start', atMs: 0 },
          {
            type: 'message_end',
            atMs: 4,
            message: {
              role: 'assistant',
              content: [],
              stopReason: 'error',
              errorMessage: '503: upstream unavailable',
            },
          },
          { type: 'agent_end', atMs: 8 },
        ],
        { traceJoin: EMPTY_JOIN },
      ),
    );
    expect(upstream.failure_class).toBe('transport');

    const sentinel = sentinelFor('text_sentinel_stream', 20260818, 0, 'yorha');
    const clean = [
      { type: 'agent_start', atMs: 0 },
      {
        type: 'message_end',
        atMs: 6,
        message: { role: 'assistant', content: sentinel, stopReason: 'stop' },
      },
      { type: 'agent_end', atMs: 9 },
    ];
    const fromDiagnostics = assembleTrialRecord(
      requestFor('text_sentinel_stream', 'yorha'),
      sampleFor(clean, {
        traceJoin: {
          sequence_start: 1,
          sequence_end: 1,
          request_ids: ['req-auth-2'],
          record_count: 1,
          attributed_run_count: 1,
          synchronized: true,
        },
        upstreamRuns: 1,
        childReport: {
          diagnostics: `provider rejected request ${AUTH_401}`,
          exits: [{ code: 0, signal: null }],
          session: null,
        },
      }),
    );
    expect(fromDiagnostics.failure_class).toBe('auth');

    const benign = assembleTrialRecord(
      requestFor('text_sentinel_stream', 'yorha'),
      sampleFor(clean, {
        traceJoin: {
          sequence_start: 1,
          sequence_end: 1,
          request_ids: ['req-auth-3'],
          record_count: 1,
          attributed_run_count: 1,
          synchronized: true,
        },
        upstreamRuns: 1,
        childReport: {
          diagnostics: "omo-senpi ulw-loop status ignored { reason: 'non-zero-exit', code: 1 }",
          exits: [{ code: 0, signal: null }],
          session: null,
        },
      }),
    );
    expect(benign.failure_class).toBeNull();
  });
});

const FAKE_OMO = (mode: 'ok' | 'fail') => `#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('${VERSION.trim()}\\n');
  process.exit(0);
}
if (args.includes('--list-models')) {
  process.stdout.write('${MODELS.trim()}\\n');
  process.exit(0);
}
const sessionDir = args[args.indexOf('--session-dir') + 1];
let prompt = '';
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
  const transcript = [
    JSON.stringify({ kind: 'session' }),
    JSON.stringify({ kind: 'message', message: { role: 'user', content: prompt } }),
  ];
  if (${mode === 'ok'}) {
    transcript.push(JSON.stringify({ kind: 'message', message: { role: 'assistant', content: 'ok', stopReason: 'stop' } }));
  } else {
    transcript.push(JSON.stringify({ kind: 'message', message: { role: 'assistant', content: '', stopReason: 'error', errorMessage: '${AUTH_401.replace(/"/g, '\\"')}' } }));
  }
  const stdout = ${mode === 'ok'} ? [
    JSON.stringify({ type: 'agent_start' }),
    JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'ok' } }),
    JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: 'ok', stopReason: 'stop' } }),
    JSON.stringify({ type: 'agent_end' }),
  ] : [
    JSON.stringify({ type: 'agent_start' }),
    JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: '', stopReason: 'error', errorMessage: '${AUTH_401.replace(/"/g, '\\"')}' } }),
  ];
  void writeFile(\`\${sessionDir}/session.jsonl\`, transcript.join('\\n') + '\\n').then(() => {
    process.stderr.write('fake-omo-child-diagnostic\\n');
    process.stdout.write(stdout.join('\\n') + '\\n');
    process.exit(${mode === 'ok' ? 0 : 9});
  });
});
`;

describe('executor child-report propagation', () => {
  it('carries diagnostics, exit metadata, and session summary on success and error paths', async () => {
    const { root, authStorePath, modelStorePath } = await disposableStores();
    const okBin = join(root, 'fake-omo-ok.mjs');
    const failBin = join(root, 'fake-omo-fail.mjs');
    await writeFile(okBin, FAKE_OMO('ok'), { mode: 0o755 });
    await writeFile(failBin, FAKE_OMO('fail'), { mode: 0o755 });
    await chmod(okBin, 0o755);
    await chmod(failBin, 0o755);
    const collector = new BridgeTraceCollector();
    const bridge = {
      port: 0,
      baseUrl: 'http://127.0.0.1:9911',
      trace: () => collector.snapshot(),
      traceRecords: () => collector.records(),
      beginTraceScope: () => collector.beginScope(),
      cleanupReceipt: () => ({
        benchmark_owned_pid: null,
        close_observed: true,
        exit_code: 0,
        exit_signal: null,
      }),
      stop: async () => undefined,
    };
    const signal = new AbortController().signal;
    const context = (omoBin: string) => ({
      bridge,
      authStorePath,
      modelStorePath,
      omoBin,
      trialTimeoutMs: 5_000,
      tempRoot: root,
      signal,
    });

    const success = await makeExecutor(context(okBin))(
      requestFor('text_sentinel_stream', 'native'),
    );
    expect(success.childReport.diagnostics).toContain('fake-omo-child-diagnostic');
    expect(success.childReport.exits).toEqual([{ code: 0, signal: null }]);
    expect(success.childReport.session).toMatchObject({
      user_messages: 1,
      errored_assistant_messages: 0,
    });

    const failure = await makeExecutor(context(failBin))(
      requestFor('text_sentinel_stream', 'native'),
    );
    expect(failure.failureClass).toBe('early_exit');
    expect(failure.childReport.exits).toEqual([{ code: 9, signal: null }]);
    expect(failure.childReport.diagnostics).toContain('fake-omo-child-diagnostic');
    expect(failure.childReport.session).toMatchObject({ errored_assistant_messages: 1 });
    const record = assembleTrialRecord(requestFor('text_sentinel_stream', 'native'), failure);
    expect(record.child_report.exits).toEqual([{ code: 9, signal: null }]);
    expect(record.child_report.session).toMatchObject({ errored_assistant_messages: 1 });
    expect(JSON.stringify(record)).not.toContain('fixture prompt');
  });
});
