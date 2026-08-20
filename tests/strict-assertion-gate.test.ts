import { spawnSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const GATE_SCRIPT = 'scripts/check-strict-assertions.mjs';
const PLANTED_DIR = 'tests/support/gate-proof';
const PLANTED_FILE = `${PLANTED_DIR}/planted.ts`;
// Every detector's syntax escape in one typecheck-clean, lint-clean fixture.
const PLANTED_SOURCE = [
  'const value: string | undefined = "x";',
  'const asserted = value!;',
  'let deferredResolve!: () => void;',
  'const typed: any = asserted;',
  '// @ts-ignore',
  'void typed;',
  'void deferredResolve;',
  '',
].join('\n');

function runGate(scope: string): { status: number; output: string } {
  const result = spawnSync(process.execPath, [GATE_SCRIPT, scope], { encoding: 'utf8' });
  if (result.error) throw result.error;
  return { status: result.status ?? -1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

describe('strict-assertion gate', () => {
  it('fails when a changed TypeScript file reintroduces every banned escape', async () => {
    // Given: an untracked TypeScript file carrying all four banned syntax escapes.
    await mkdir(PLANTED_DIR, { recursive: true });
    await writeFile(PLANTED_FILE, PLANTED_SOURCE, 'utf8');

    try {
      // When: the gate scans the planted scope.
      const result = runGate(PLANTED_DIR);

      // Then: it exits nonzero and names each detector's finding.
      expect(result.status).not.toBe(0);
      expect(result.output).toContain('non-null expressions: 1');
      expect(result.output).toContain('definite-assignment assertions: 1');
      expect(result.output).toContain('explicit any: 1');
      expect(result.output).toContain('suppressions: 1');
    } finally {
      await rm(PLANTED_DIR, { recursive: true, force: true });
    }
  });

  it('passes once the planted file is removed from the changed tree', () => {
    // Given: no planted escape remains under the gate-proof scope.
    // When: the gate scans that scope.
    const result = runGate(PLANTED_DIR);

    // Then: it exits zero over zero scanned files.
    expect(result.status).toBe(0);
    expect(result.output).toContain('scanned 0 changed/untracked TypeScript files');
  });
});
