import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { canonicalTaskPath, isPathWithin, TaskPathError } from './task-owned-path.js';

const AbsoluteComparatorPathSchema = z.string().min(1).refine(isAbsolute).brand('ComparatorPath');

export type ComparatorExecutable = z.infer<typeof AbsoluteComparatorPathSchema>;
export type ComparatorPathFailure =
  | 'missing_explicit_path'
  | 'relative_path'
  | 'outside_task_root'
  | 'symlink_path'
  | 'path_changed'
  | 'not_executable';

export type ComparatorResolution =
  | {
      readonly ok: true;
      readonly executable: ComparatorExecutable;
      readonly sanitizedPath: string;
      readonly provenance: 'task_owned_absolute';
    }
  | {
      readonly ok: false;
      readonly reason: ComparatorPathFailure;
      readonly expectedRoot: '$PROJECT/.omo/comparators';
    };

export function benchmarkComparatorRoot(projectRoot: string): string {
  return join(resolve(projectRoot), '.omo', 'comparators');
}

export async function resolveBenchmarkComparator(
  rawPath: string | undefined,
  projectRoot: string,
): Promise<ComparatorResolution> {
  if (rawPath === undefined || rawPath.length === 0) {
    return {
      ok: false,
      reason: 'missing_explicit_path',
      expectedRoot: '$PROJECT/.omo/comparators',
    };
  }
  const parsed = AbsoluteComparatorPathSchema.safeParse(rawPath);
  if (!parsed.success) {
    return { ok: false, reason: 'relative_path', expectedRoot: '$PROJECT/.omo/comparators' };
  }
  const root = benchmarkComparatorRoot(projectRoot);
  const lexicalPath = resolve(parsed.data);
  if (!isPathWithin(root, lexicalPath)) {
    return { ok: false, reason: 'outside_task_root', expectedRoot: '$PROJECT/.omo/comparators' };
  }
  try {
    const canonical = await canonicalTaskPath({
      projectRoot,
      taskRoot: root,
      candidate: lexicalPath,
      kind: 'file',
    });
    await access(canonical.candidate, constants.X_OK);
    const stable = await canonicalTaskPath({
      projectRoot,
      taskRoot: root,
      candidate: lexicalPath,
      kind: 'file',
    });
    if (stable.candidate !== canonical.candidate) {
      return { ok: false, reason: 'path_changed', expectedRoot: '$PROJECT/.omo/comparators' };
    }
    return {
      ok: true,
      executable: AbsoluteComparatorPathSchema.parse(stable.candidate),
      sanitizedPath: `$PROJECT/${relative(stable.projectRoot, stable.candidate)}`,
      provenance: 'task_owned_absolute',
    };
  } catch (error) {
    if (error instanceof TaskPathError) {
      return { ok: false, reason: error.reason, expectedRoot: '$PROJECT/.omo/comparators' };
    }
    if (error instanceof Error) {
      return { ok: false, reason: 'not_executable', expectedRoot: '$PROJECT/.omo/comparators' };
    }
    throw error;
  }
}
