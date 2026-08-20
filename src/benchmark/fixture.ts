import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseNativeCursorAuthContents, serializeNativeCursorAuth } from './fixture-auth.js';
import { providerDefinition } from './fixture-provider.js';
import { canonicalToolExtension } from './fixture-tools.js';

const SECURE = { mode: 0o600 } as const;

export interface BenchmarkFixtureOptions {
  authStorePath: string;
  modelStorePath: string;
  bridgeBaseUrl: string;
  tempRoot?: string;
}

export interface BenchmarkFixture {
  rootDir: string;
  cwd: string;
  agentDir: string;
  sessionDir: string;
  toolExtensionPath: string;
  redactions: readonly string[];
  dispose(): Promise<void>;
}

export class ModelStoreError extends Error {}

export interface OmoJsonEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

export function omoTrialArgs(
  provider: string,
  model: string,
  fixture: Pick<BenchmarkFixture, 'sessionDir' | 'toolExtensionPath'>,
  seed: string,
): string[] {
  return [
    '--mode',
    'json',
    '--print',
    '--offline',
    '--provider',
    provider,
    '--model',
    model,
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

export function benchmarkEnvironment(fixture: BenchmarkFixture, seed: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const inherited =
    'PATH HOME USERPROFILE TMPDIR TMP TEMP LANG LC_ALL HTTPS_PROXY HTTP_PROXY NO_PROXY NODE_EXTRA_CA_CERTS'.split(
      ' ',
    );
  for (const name of inherited) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return {
    ...env,
    NO_COLOR: '1',
    OMO_CODING_AGENT_DIR: fixture.agentDir,
    SENPI_CODING_AGENT_DIR: fixture.agentDir,
    PI_CODING_AGENT_DIR: fixture.agentDir,
    OMO_LSP_DAEMON_DIR: join(fixture.rootDir, 'lsp-daemon'),
    OMO_BENCHMARK_SEED: seed,
  };
}

export function redactBenchmarkText(value: string, sensitive: readonly string[]): string {
  let safe = value;
  for (const item of sensitive.filter(Boolean)) safe = safe.split(item).join('[redacted-path]');
  return safe
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted-secret]')
    .replace(/(["']?(?:token|secret|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[redacted]');
}

export function redactBenchmarkValue(value: unknown, sensitive: readonly string[]): unknown {
  if (typeof value === 'string') return redactBenchmarkText(value, sensitive);
  if (Array.isArray(value)) return value.map((item) => redactBenchmarkValue(item, sensitive));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactBenchmarkValue(item, sensitive)]),
    );
  }
  return value;
}

function jsonStrings(contents: string): string[] {
  return contents.match(/[A-Za-z0-9][A-Za-z0-9:/._-]{7,}/g) ?? [];
}

export async function createBenchmarkFixture(
  options: BenchmarkFixtureOptions,
): Promise<BenchmarkFixture> {
  const authStorePath = resolve(options.authStorePath);
  const modelStorePath = resolve(options.modelStorePath);
  await access(authStorePath);
  const authContents = await readFile(authStorePath, 'utf8');
  const authSnapshot = parseNativeCursorAuthContents(authContents);
  let modelStoreContents: string;
  try {
    modelStoreContents = await readFile(modelStorePath, 'utf8');
    const catalog = JSON.parse(modelStoreContents) as {
      cursor?: { models?: unknown };
    };
    const models = catalog.cursor?.models;
    if (
      !Array.isArray(models) ||
      !models.every((model: unknown) => Reflect.get(model as object, 'provider') === 'cursor')
    )
      throw new Error('invalid cursor model catalog');
  } catch {
    throw new ModelStoreError();
  }
  const parent = resolve(options.tempRoot ?? tmpdir());
  await mkdir(parent, { recursive: true });
  const rootDir = await mkdtemp(join(parent, 'cursor-composer-benchmark-'));
  const cwd = join(rootDir, 'workspace');
  const agentDir = join(rootDir, 'agent');
  const sessionDir = join(rootDir, 'sessions');
  const toolExtensionPath = join(rootDir, 'benchmark-tools.mjs');
  let disposed = false;

  const onboardingDir = join(agentDir, 'omo-senpi', 'omo-native');
  try {
    await Promise.all([
      mkdir(join(cwd, 'data'), { recursive: true }),
      mkdir(agentDir, { recursive: true }),
      mkdir(onboardingDir, { recursive: true }),
      mkdir(sessionDir, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        join(cwd, 'fixture.txt'),
        'alpha=17\nbeta=23\nsentinel=FIXTURE_COMPOSER_25\n',
        SECURE,
      ),
      writeFile(join(cwd, 'data', 'codes.json'), '{"ALPHA":"A-17","BETA":"B-23"}\n', SECURE),
      writeFile(join(agentDir, 'models.json'), providerDefinition(options.bridgeBaseUrl), SECURE),
      writeFile(join(agentDir, 'models-store.json'), modelStoreContents, {
        mode: 0o400,
      }),
      writeFile(toolExtensionPath, canonicalToolExtension(), SECURE),
      writeFile(join(onboardingDir, 'onboarding-completed'), '', SECURE),
      writeFile(join(agentDir, 'auth.json'), serializeNativeCursorAuth(authSnapshot), SECURE),
    ]);
  } catch (error) {
    await rm(rootDir, { recursive: true, force: true });
    throw error;
  }

  return {
    rootDir,
    cwd,
    agentDir,
    sessionDir,
    toolExtensionPath,
    redactions: [authStorePath, modelStorePath, ...jsonStrings(authContents)],
    async dispose() {
      if (disposed) return;
      disposed = true;
      await rm(rootDir, { recursive: true, force: true });
    },
  };
}
