import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveBenchmarkComparator } from '../src/benchmark/comparator.js';

const roots: string[] = [];

async function projectFixture(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), 'comparator-symlink-test-'));
  roots.push(projectRoot);
  await mkdir(join(projectRoot, '.omo'), { recursive: true });
  return projectRoot;
}

async function executable(path: string): Promise<void> {
  await writeFile(path, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('benchmark comparator canonical containment', () => {
  it('rejects a comparator root symlink to another in-project directory', async () => {
    // Given: .omo/comparators redirects to a different physical project directory.
    const projectRoot = await projectFixture();
    const redirectedRoot = join(projectRoot, 'other-owned-dir');
    await mkdir(redirectedRoot);
    await executable(join(redirectedRoot, 'omo'));
    await symlink(redirectedRoot, join(projectRoot, '.omo', 'comparators'), 'dir');

    // When: the redirected executable is resolved.
    const result = await resolveBenchmarkComparator(
      join(projectRoot, '.omo', 'comparators', 'omo'),
      projectRoot,
    );

    // Then: lexical project ownership cannot substitute for the canonical task root.
    expect(result).toMatchObject({ ok: false, reason: 'symlink_path' });
  });

  it('rejects a symlinked directory component beneath the comparator root', async () => {
    // Given: an executable reached through a symlink below the real task root.
    const projectRoot = await projectFixture();
    const taskRoot = join(projectRoot, '.omo', 'comparators');
    const realDirectory = join(taskRoot, 'real');
    await mkdir(realDirectory, { recursive: true });
    await executable(join(realDirectory, 'omo'));
    await symlink(realDirectory, join(taskRoot, 'linked'), 'dir');

    // When: the linked path is resolved.
    const result = await resolveBenchmarkComparator(join(taskRoot, 'linked', 'omo'), projectRoot);

    // Then: every supplied path component must be physically owned and non-symlinked.
    expect(result).toMatchObject({ ok: false, reason: 'symlink_path' });
  });

  it('rejects a symlinked executable even when its target is inside the task root', async () => {
    // Given: the final executable component is a symlink to an in-root file.
    const projectRoot = await projectFixture();
    const taskRoot = join(projectRoot, '.omo', 'comparators');
    await mkdir(taskRoot, { recursive: true });
    await executable(join(taskRoot, 'real-omo'));
    await symlink('real-omo', join(taskRoot, 'omo'), 'file');

    // When: the symlink executable is resolved.
    const result = await resolveBenchmarkComparator(join(taskRoot, 'omo'), projectRoot);

    // Then: the explicit comparator path itself must contain no symlink component.
    expect(result).toMatchObject({ ok: false, reason: 'symlink_path' });
  });
});
