#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import {
  inspectOmoComparator,
  PINNED_OMO_VERSION,
  PINNED_SENPI_VERSION,
} from './comparator-inspection.js';
import {
  canonicalInstalledExecutable,
  cleanupMaterializationPrefix,
  prepareMaterializationPrefix,
  verifyMaterializationPrefix,
} from './comparator-materialization-path.js';
import {
  COMPARATOR_PACKAGE_SPEC,
  ComparatorMaterializationError,
  materializationReceipt,
  type ComparatorMaterializationReceipt,
} from './comparator-materialization-receipt.js';
import { TaskPathError } from './task-owned-path.js';
const PackageManifestSchema = z.object({ name: z.string(), version: z.string() });

export { comparatorMaterializationPrefix } from './comparator-materialization-path.js';
export { ComparatorMaterializationError } from './comparator-materialization-receipt.js';
export type {
  ComparatorMaterializationErrorCode,
  ComparatorMaterializationReceipt,
} from './comparator-materialization-receipt.js';

export interface MaterializerCommandOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
}

export type MaterializerCommand = (
  command: string,
  args: readonly string[],
  options: MaterializerCommandOptions,
) => Promise<string>;

export interface ComparatorMaterializationOptions {
  readonly projectRoot: string;
  readonly modelStorePath: string;
}

function runCommand(
  command: string,
  args: readonly string[],
  options: MaterializerCommandOptions,
): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    execFile(
      command,
      [...args],
      {
        cwd: options.cwd,
        env: options.env,
        signal: options.signal,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolveOutput(stdout);
      },
    );
  });
}

function unsafePathError(error: TaskPathError): ComparatorMaterializationError {
  return new ComparatorMaterializationError('comparator task path is not physically owned', {
    code: 'unsafe_task_path',
    cause: error,
  });
}

export async function cleanupMaterializedComparator(projectRoot: string): Promise<void> {
  try {
    await cleanupMaterializationPrefix(projectRoot);
  } catch (error) {
    if (error instanceof TaskPathError) throw unsafePathError(error);
    throw error;
  }
}

export async function materializeOmoComparator(
  options: ComparatorMaterializationOptions,
  dependencies: { readonly run: MaterializerCommand } = { run: runCommand },
): Promise<ComparatorMaterializationReceipt> {
  const projectRoot = resolve(options.projectRoot);
  if (!isAbsolute(options.modelStorePath)) {
    throw new ComparatorMaterializationError('model store path must be absolute', {
      code: 'materialization_failed',
    });
  }
  try {
    const prefix = await prepareMaterializationPrefix(projectRoot);
    const npmConfig = join(prefix.candidate, '.npmrc');
    const npmLogs = join(prefix.candidate, '.npm-logs');
    const agentDir = join(prefix.candidate, '.qa-agent');
    const homeDir = join(prefix.candidate, '.qa-home');
    await Promise.all([
      mkdir(npmLogs),
      mkdir(join(agentDir, 'omo-senpi', 'omo-native'), { recursive: true }),
      mkdir(homeDir),
    ]);
    await Promise.all([
      writeFile(npmConfig, 'global=false\nupdate-notifier=false\n'),
      copyFile(options.modelStorePath, join(agentDir, 'models-store.json')),
      writeFile(join(agentDir, 'omo-senpi', 'omo-native', 'onboarding-completed'), ''),
    ]);
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: homeDir,
      NO_COLOR: '1',
      OMO_CODING_AGENT_DIR: agentDir,
      SENPI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_DIR: agentDir,
      npm_config_cache: process.env.npm_config_cache ?? join(homedir(), '.npm'),
      npm_config_logs_dir: npmLogs,
      npm_config_update_notifier: 'false',
    };
    await dependencies.run(
      'npm',
      [
        'install',
        '--offline',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--package-lock=false',
        '--userconfig',
        npmConfig,
        '--prefix',
        prefix.candidate,
        COMPARATOR_PACKAGE_SPEC,
      ],
      { cwd: projectRoot, env },
    );
    const stablePrefix = await verifyMaterializationPrefix(projectRoot);
    const linkedExecutable = join(stablePrefix.candidate, 'node_modules', '.bin', 'omo');
    const executable = await canonicalInstalledExecutable(projectRoot, linkedExecutable);
    const omoManifest = PackageManifestSchema.parse(
      JSON.parse(
        await readFile(
          join(stablePrefix.candidate, 'node_modules', 'omo-ai', 'package.json'),
          'utf8',
        ),
      ),
    );
    const senpiManifest = PackageManifestSchema.parse(
      JSON.parse(
        await readFile(
          join(stablePrefix.candidate, 'node_modules', '@code-yeongyu', 'senpi', 'package.json'),
          'utf8',
        ),
      ),
    );
    await access(executable.candidate, constants.X_OK);
    if (
      omoManifest.name !== 'omo-ai' ||
      omoManifest.version !== PINNED_OMO_VERSION ||
      senpiManifest.name !== '@code-yeongyu/senpi' ||
      senpiManifest.version !== PINNED_SENPI_VERSION
    ) {
      throw new ComparatorMaterializationError('materialized package versions do not match pins', {
        code: 'materialization_failed',
      });
    }
    const inspection = await inspectOmoComparator(
      executable.candidate,
      env,
      (command, args, commandEnv, signal) =>
        dependencies.run(command, args, { cwd: projectRoot, env: commandEnv, signal }),
      30_000,
    );
    const stableExecutable = await canonicalInstalledExecutable(projectRoot, linkedExecutable);
    const receipt = materializationReceipt(stablePrefix, stableExecutable, inspection);
    if (!receipt.matches_pins) {
      throw new ComparatorMaterializationError('materialized comparator inspection failed', {
        code: 'inspection_mismatch',
        receipt,
      });
    }
    return receipt;
  } catch (error) {
    try {
      await cleanupMaterializationPrefix(projectRoot);
    } catch (cleanupError) {
      if (cleanupError instanceof TaskPathError) throw unsafePathError(cleanupError);
      throw cleanupError;
    }
    if (error instanceof ComparatorMaterializationError) throw error;
    if (error instanceof TaskPathError) throw unsafePathError(error);
    if (error instanceof Error) {
      throw new ComparatorMaterializationError('offline comparator materialization failed', {
        code: 'materialization_failed',
        cause: error,
      });
    }
    throw new ComparatorMaterializationError('materialization failed with a non-error value', {
      code: 'materialization_failed',
    });
  }
}

async function main(): Promise<void> {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  if (process.argv.slice(2).includes('--cleanup')) {
    await cleanupMaterializedComparator(projectRoot);
    console.log(JSON.stringify({ cleaned: true, prefix: '$PROJECT/.omo/comparators' }));
    return;
  }
  const modelStorePath = process.env.CURSOR_BENCH_MODEL_STORE;
  if (modelStorePath === undefined || !isAbsolute(modelStorePath)) {
    throw new ComparatorMaterializationError(
      'CURSOR_BENCH_MODEL_STORE must be an absolute readable model-store path',
      { code: 'materialization_failed' },
    );
  }
  console.log(JSON.stringify(await materializeOmoComparator({ projectRoot, modelStorePath })));
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'comparator materialization failed');
    process.exitCode = 1;
  });
}
