import { lstat, mkdir, realpath, rm } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { PINNED_OMO_VERSION } from './comparator-inspection.js';
import {
  canonicalTaskPath,
  isPathWithin,
  TaskPathError,
  type CanonicalTaskPath,
} from './task-owned-path.js';

export interface MaterializationPaths {
  readonly projectRoot: string;
  readonly taskRoot: string;
  readonly prefix: string;
}

export function comparatorMaterializationPrefix(projectRoot: string): string {
  return join(resolve(projectRoot), '.omo', 'comparators', `omo-ai-${PINNED_OMO_VERSION}`);
}

export function materializationPaths(projectRoot: string): MaterializationPaths {
  const project = resolve(projectRoot);
  return {
    projectRoot: project,
    taskRoot: join(project, '.omo', 'comparators'),
    prefix: comparatorMaterializationPrefix(project),
  };
}

function errnoCode(error: unknown): unknown {
  return error !== null && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
}

async function ensureOwnedDirectory(path: string): Promise<void> {
  try {
    const existing = await lstat(path);
    if (existing.isSymbolicLink()) throw new TaskPathError('symlink_path');
    if (!existing.isDirectory()) throw new TaskPathError('outside_task_root');
    return;
  } catch (error) {
    if (error instanceof TaskPathError) throw error;
    if (errnoCode(error) !== 'ENOENT') throw error;
  }
  try {
    await mkdir(path);
  } catch (error) {
    if (errnoCode(error) !== 'EEXIST') throw error;
  }
  const created = await lstat(path);
  if (created.isSymbolicLink()) throw new TaskPathError('symlink_path');
  if (!created.isDirectory()) throw new TaskPathError('outside_task_root');
}

async function verifiedPrefix(paths: MaterializationPaths): Promise<CanonicalTaskPath> {
  return canonicalTaskPath({
    projectRoot: paths.projectRoot,
    taskRoot: paths.taskRoot,
    candidate: paths.prefix,
    kind: 'directory',
  });
}

export async function prepareMaterializationPrefix(
  projectRoot: string,
): Promise<CanonicalTaskPath> {
  const paths = materializationPaths(projectRoot);
  await ensureOwnedDirectory(join(paths.projectRoot, '.omo'));
  await ensureOwnedDirectory(paths.taskRoot);
  try {
    const prefixStat = await lstat(paths.prefix);
    if (prefixStat.isSymbolicLink()) throw new TaskPathError('symlink_path');
    await verifiedPrefix(paths);
    await rm(paths.prefix, { recursive: true });
  } catch (error) {
    if (error instanceof TaskPathError) throw error;
    if (errnoCode(error) !== 'ENOENT') throw error;
  }
  await mkdir(paths.prefix);
  return verifiedPrefix(paths);
}

export async function verifyMaterializationPrefix(projectRoot: string): Promise<CanonicalTaskPath> {
  return verifiedPrefix(materializationPaths(projectRoot));
}

export async function cleanupMaterializationPrefix(projectRoot: string): Promise<void> {
  const paths = materializationPaths(projectRoot);
  await ensureOwnedDirectory(join(paths.projectRoot, '.omo'));
  await ensureOwnedDirectory(paths.taskRoot);
  try {
    const prefixStat = await lstat(paths.prefix);
    if (prefixStat.isSymbolicLink()) throw new TaskPathError('symlink_path');
    await verifiedPrefix(paths);
    await rm(paths.prefix, { recursive: true });
  } catch (error) {
    if (error instanceof TaskPathError) throw error;
    if (errnoCode(error) !== 'ENOENT') throw error;
  }
}

export async function canonicalInstalledExecutable(
  projectRoot: string,
  linkedExecutable: string,
): Promise<CanonicalTaskPath> {
  const paths = materializationPaths(projectRoot);
  const prefix = await verifiedPrefix(paths);
  const [canonicalProject, firstTarget] = await Promise.all([
    realpath(paths.projectRoot),
    realpath(linkedExecutable),
  ]);
  if (!isPathWithin(canonicalProject, firstTarget)) {
    throw new TaskPathError('outside_task_root');
  }
  const lexicalTarget = resolve(paths.projectRoot, relative(canonicalProject, firstTarget));
  const first = await canonicalTaskPath({
    projectRoot: paths.projectRoot,
    taskRoot: paths.taskRoot,
    candidate: lexicalTarget,
    kind: 'file',
  });
  if (!isPathWithin(prefix.candidate, first.candidate)) {
    throw new TaskPathError('outside_task_root');
  }
  const secondTarget = await realpath(linkedExecutable);
  const stablePrefix = await verifiedPrefix(paths);
  if (secondTarget !== first.candidate || stablePrefix.candidate !== prefix.candidate) {
    throw new TaskPathError('path_changed');
  }
  return first;
}
