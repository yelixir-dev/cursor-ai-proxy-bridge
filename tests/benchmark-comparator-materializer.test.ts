import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanupMaterializedComparator,
  ComparatorMaterializationError,
  comparatorMaterializationPrefix,
  materializeOmoComparator,
  type MaterializerCommand,
} from '../src/benchmark/comparator-materializer.js';

const roots: string[] = [];

async function fixture() {
  const projectRoot = await mkdtemp(join(tmpdir(), 'comparator-materializer-test-'));
  roots.push(projectRoot);
  const modelStorePath = join(projectRoot, 'models-store.json');
  await writeFile(
    modelStorePath,
    JSON.stringify({ cursor: { models: [{ id: 'composer-2.5', provider: 'cursor' }] } }),
  );
  return { projectRoot, modelStorePath };
}

async function fakeInstall(prefix: string): Promise<string> {
  const packageRoot = join(prefix, 'node_modules');
  const executable = join(packageRoot, 'omo-ai', 'bin', 'omo.js');
  await Promise.all([
    mkdir(join(packageRoot, '.bin'), { recursive: true }),
    mkdir(join(packageRoot, 'omo-ai', 'bin'), { recursive: true }),
    mkdir(join(packageRoot, '@code-yeongyu', 'senpi'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(packageRoot, 'omo-ai', 'package.json'),
      JSON.stringify({ name: 'omo-ai', version: '5.0.0-0.beta.9' }),
    ),
    writeFile(
      join(packageRoot, '@code-yeongyu', 'senpi', 'package.json'),
      JSON.stringify({ name: '@code-yeongyu/senpi', version: '2026.8.17' }),
    ),
    writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 }),
  ]);
  await symlink('../omo-ai/bin/omo.js', join(packageRoot, '.bin', 'omo'), 'file');
  return executable;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('task-owned comparator materializer', () => {
  it('exposes an explicit repository-owned materialization command', async () => {
    // Given: the repository package manifest.
    const manifest: unknown = JSON.parse(await readFile('package.json', 'utf8'));
    if (manifest === null || typeof manifest !== 'object') throw new Error('invalid manifest');

    // When: the comparator workflow command is selected.
    const scripts: unknown = Reflect.get(manifest, 'scripts');
    if (scripts === null || typeof scripts !== 'object') throw new Error('invalid scripts');
    const command = Reflect.get(scripts, 'benchmark:materialize-comparator');

    // Then: the machine-consumed command invokes the typed local workflow.
    expect(command).toBe('tsx src/benchmark/comparator-materializer.ts');
  });

  it('installs exact beta.9 offline under the task root, verifies it, and cleans it', async () => {
    // Given: a fake npm cache-backed install surface and isolated model store.
    const { projectRoot, modelStorePath } = await fixture();
    const prefix = comparatorMaterializationPrefix(projectRoot);
    const canonicalPrefix = join(
      await realpath(projectRoot),
      '.omo',
      'comparators',
      'omo-ai-5.0.0-0.beta.9',
    );
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const run: MaterializerCommand = vi.fn(async (command, args) => {
      calls.push({ command, args });
      if (command === 'npm') {
        await fakeInstall(prefix);
        return '';
      }
      return args.includes('--version')
        ? 'omo 5.0.0-0.beta.9 (engine: senpi 2026.8.17)\n'
        : 'cursor composer-2.5 200K 64K no no\n';
    });

    // When: the materializer completes and its matching cleanup runs.
    const receipt = await materializeOmoComparator({ projectRoot, modelStorePath }, { run });

    // Then: install selection and verification are exact, offline, and task-owned.
    expect(calls[0]).toEqual({
      command: 'npm',
      args: expect.arrayContaining([
        'install',
        '--offline',
        '--prefix',
        canonicalPrefix,
        'omo-ai@5.0.0-0.beta.9',
      ]),
    });
    expect(calls[0]?.args).not.toContain('--global');
    expect(
      calls
        .slice(1)
        .every(
          (call) =>
            call.command === join(canonicalPrefix, 'node_modules', 'omo-ai', 'bin', 'omo.js'),
        ),
    ).toBe(true);
    expect(calls.map((call) => call.args)).toContainEqual(['--version']);
    expect(calls.map((call) => call.args)).toContainEqual([
      '--offline',
      '--list-models',
      'composer-2.5',
    ]);
    expect(receipt).toMatchObject({
      package: 'omo-ai@5.0.0-0.beta.9',
      install_mode: 'offline',
      prefix: '$PROJECT/.omo/comparators/omo-ai-5.0.0-0.beta.9',
      executable: '$PROJECT/.omo/comparators/omo-ai-5.0.0-0.beta.9/node_modules/omo-ai/bin/omo.js',
      observed_omo_version: '5.0.0-0.beta.9',
      observed_senpi_version: '2026.8.17',
      model_id: 'composer-2.5',
      model_observed: true,
    });
    await cleanupMaterializedComparator(projectRoot);
    await expect(access(prefix)).rejects.toThrow();
  });

  it('retains mismatched executable observations without replacing them with pins', async () => {
    // Given: exact pinned packages whose invoked executable reports a different runtime.
    const { projectRoot, modelStorePath } = await fixture();
    const prefix = comparatorMaterializationPrefix(projectRoot);
    const run: MaterializerCommand = vi.fn(async (command, args) => {
      if (command === 'npm') {
        await fakeInstall(prefix);
        return '';
      }
      return args.includes('--version')
        ? 'omo 5.0.0-0.beta.10 (engine: senpi 2026.8.18)\n'
        : 'cursor composer-2.5 200K 64K no no\n';
    });

    // When: executable inspection detects a runtime mismatch.
    const error: unknown = await materializeOmoComparator(
      { projectRoot, modelStorePath },
      { run },
    ).catch((reason: unknown) => reason);

    // Then: the rejected receipt reports observations, not expected constants.
    expect(error).toBeInstanceOf(ComparatorMaterializationError);
    if (!(error instanceof ComparatorMaterializationError)) {
      throw new TypeError('expected ComparatorMaterializationError');
    }
    expect(error.receipt).toMatchObject({
      observed_omo_version: '5.0.0-0.beta.10',
      observed_senpi_version: '2026.8.18',
      matches_pins: false,
    });
  });

  it('removes a partial package tree when offline materialization fails', async () => {
    // Given: a task-owned prefix and a failing offline package runner.
    const { projectRoot, modelStorePath } = await fixture();
    const prefix = comparatorMaterializationPrefix(projectRoot);
    const run: MaterializerCommand = vi.fn(async () => {
      await mkdir(prefix, { recursive: true });
      throw new Error('offline cache miss');
    });

    // When: materialization fails.
    await expect(
      materializeOmoComparator({ projectRoot, modelStorePath }, { run }),
    ).rejects.toBeInstanceOf(ComparatorMaterializationError);

    // Then: no partial package tree remains.
    await expect(access(prefix)).rejects.toThrow();
  });
});
