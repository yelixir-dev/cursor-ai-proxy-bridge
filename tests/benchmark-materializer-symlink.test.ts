import { access, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanupMaterializedComparator,
  ComparatorMaterializationError,
  materializeOmoComparator,
  type MaterializerCommand,
} from '../src/benchmark/comparator-materializer.js';

const roots: string[] = [];

async function fixture() {
  const projectRoot = await mkdtemp(join(tmpdir(), 'materializer-symlink-project-'));
  const outsideRoot = await mkdtemp(join(tmpdir(), 'materializer-symlink-outside-'));
  roots.push(projectRoot, outsideRoot);
  const modelStorePath = join(projectRoot, 'models-store.json');
  await writeFile(
    modelStorePath,
    JSON.stringify({ cursor: { models: [{ id: 'composer-2.5', provider: 'cursor' }] } }),
  );
  await mkdir(join(projectRoot, '.omo'), { recursive: true });
  return { projectRoot, outsideRoot, modelStorePath };
}

async function capturedError(action: Promise<unknown>): Promise<ComparatorMaterializationError> {
  const error: unknown = await action.catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(ComparatorMaterializationError);
  if (!(error instanceof ComparatorMaterializationError)) {
    throw new TypeError('expected ComparatorMaterializationError');
  }
  return error;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('materializer canonical task ownership', () => {
  it.each(['outside-project', 'inside-project'] as const)(
    'rejects a comparator root symlink to %s storage before npm runs',
    async (targetKind) => {
      // Given: the task root is a directory symlink rather than owned storage.
      const { projectRoot, outsideRoot, modelStorePath } = await fixture();
      const target =
        targetKind === 'outside-project' ? outsideRoot : join(projectRoot, 'redirected-storage');
      await mkdir(target, { recursive: true });
      await symlink(target, join(projectRoot, '.omo', 'comparators'), 'dir');
      const run = vi.fn<MaterializerCommand>();

      // When: materialization validates its destination.
      const error = await capturedError(
        materializeOmoComparator({ projectRoot, modelStorePath }, { run }),
      );

      // Then: no package command can cross the symlinked root.
      expect(error.code).toBe('unsafe_task_path');
      expect(run).not.toHaveBeenCalled();
    },
  );

  it('refuses cleanup through a symlinked comparator root', async () => {
    // Given: an outside directory visible through .omo/comparators.
    const { projectRoot, outsideRoot } = await fixture();
    const sentinel = join(outsideRoot, 'preserve.txt');
    await writeFile(sentinel, 'preserve');
    await symlink(outsideRoot, join(projectRoot, '.omo', 'comparators'), 'dir');

    // When: task cleanup is requested.
    const error = await capturedError(cleanupMaterializedComparator(projectRoot));

    // Then: cleanup rejects rather than traversing the link or touching outside state.
    expect(error.code).toBe('unsafe_task_path');
    await expect(access(sentinel)).resolves.toBeUndefined();
  });

  it('detects a comparator-root swap during npm execution without following it in cleanup', async () => {
    // Given: npm execution swaps the verified task root for an outside symlink.
    const { projectRoot, outsideRoot, modelStorePath } = await fixture();
    const taskRoot = join(projectRoot, '.omo', 'comparators');
    const sentinel = join(outsideRoot, 'preserve.txt');
    await writeFile(sentinel, 'preserve');
    const run: MaterializerCommand = vi.fn(async (command) => {
      if (command === 'npm') {
        await rm(taskRoot, { recursive: true, force: true });
        await symlink(outsideRoot, taskRoot, 'dir');
      }
      return '';
    });

    // When: post-install path verification observes the swapped root.
    const error = await capturedError(
      materializeOmoComparator({ projectRoot, modelStorePath }, { run }),
    );

    // Then: the race is classified and outside state remains untouched.
    expect(error.code).toBe('unsafe_task_path');
    await expect(access(sentinel)).resolves.toBeUndefined();
  });
});
