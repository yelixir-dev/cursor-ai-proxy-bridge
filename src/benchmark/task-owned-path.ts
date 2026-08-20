import type { Stats } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export type TaskPathFailure = 'outside_task_root' | 'symlink_path' | 'path_changed';

export class TaskPathError extends Error {
  readonly name = 'TaskPathError';

  constructor(readonly reason: TaskPathFailure) {
    super(reason);
  }
}

export interface CanonicalTaskPathOptions {
  readonly projectRoot: string;
  readonly taskRoot: string;
  readonly candidate: string;
  readonly kind: 'directory' | 'file';
}

export interface CanonicalTaskPath {
  readonly projectRoot: string;
  readonly taskRoot: string;
  readonly candidate: string;
}

export function isPathWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function componentPaths(base: string, candidate: string): readonly string[] {
  const child = relative(base, candidate);
  if (child === '') return [base];
  if (child.startsWith('..') || isAbsolute(child)) throw new TaskPathError('outside_task_root');
  const paths = [base];
  let current = base;
  for (const component of child.split(sep)) {
    current = join(current, component);
    paths.push(current);
  }
  return paths;
}

async function nonSymlinkStats(paths: readonly string[]): Promise<readonly Stats[]> {
  const stats = await Promise.all(paths.map((path) => lstat(path)));
  if (stats.some((entry) => entry.isSymbolicLink())) throw new TaskPathError('symlink_path');
  return stats;
}

function sameIdentity(first: readonly Stats[], second: readonly Stats[]): boolean {
  return (
    first.length === second.length &&
    first.every((entry, index) => {
      const other = second[index];
      return other !== undefined && entry.dev === other.dev && entry.ino === other.ino;
    })
  );
}

export async function canonicalTaskPath(
  options: CanonicalTaskPathOptions,
): Promise<CanonicalTaskPath> {
  const projectRoot = resolve(options.projectRoot);
  const taskRoot = resolve(options.taskRoot);
  const candidate = resolve(options.candidate);
  const symlinkBase = join(projectRoot, '.omo');
  if (!isPathWithin(projectRoot, taskRoot) || !isPathWithin(taskRoot, candidate)) {
    throw new TaskPathError('outside_task_root');
  }
  const paths = componentPaths(symlinkBase, candidate);
  const firstStats = await nonSymlinkStats(paths);
  const [canonicalProject, canonicalTaskRoot, canonicalCandidate] = await Promise.all([
    realpath(projectRoot),
    realpath(taskRoot),
    realpath(candidate),
  ]);
  const expectedTaskRoot = resolve(canonicalProject, relative(projectRoot, taskRoot));
  const expectedCandidate = resolve(canonicalProject, relative(projectRoot, candidate));
  if (
    canonicalTaskRoot !== expectedTaskRoot ||
    canonicalCandidate !== expectedCandidate ||
    !isPathWithin(canonicalProject, canonicalTaskRoot) ||
    !isPathWithin(canonicalTaskRoot, canonicalCandidate)
  ) {
    throw new TaskPathError('symlink_path');
  }
  const secondStats = await nonSymlinkStats(paths);
  const [stableTaskRoot, stableCandidate] = await Promise.all([
    realpath(taskRoot),
    realpath(candidate),
  ]);
  if (
    stableTaskRoot !== canonicalTaskRoot ||
    stableCandidate !== canonicalCandidate ||
    !sameIdentity(firstStats, secondStats)
  ) {
    throw new TaskPathError('path_changed');
  }
  const candidateStat = secondStats.at(-1);
  if (
    candidateStat === undefined ||
    (options.kind === 'file' ? !candidateStat.isFile() : !candidateStat.isDirectory())
  ) {
    throw new TaskPathError('outside_task_root');
  }
  return {
    projectRoot: canonicalProject,
    taskRoot: canonicalTaskRoot,
    candidate: canonicalCandidate,
  };
}
