import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { requestContextResult } from '../src/backend/cursor-api/mapper.js';
import { object, oneof } from './support/native-parity-wire.js';

describe('native suggested context shell', () => {
  it.each([
    { shell: undefined, available: ['bash'], expected: 'bash' },
    { shell: undefined, available: ['bash', 'zsh'], expected: 'zsh' },
    { shell: '/bin/fish', available: ['bash'], expected: 'bash' },
    { shell: '/custom/bash', available: ['zsh'], expected: 'bash' },
    { shell: '/bin/zsh', available: ['bash'], expected: 'zsh' },
    { shell: '/custom/powershell', available: ['bash'], expected: 'powershell' },
    { shell: undefined, available: ['pwsh'], expected: 'powershell' },
    { shell: undefined, available: [], expected: 'naive' },
  ])('selects $expected for SHELL=$shell and PATH entries $available', (fixture) => {
    // Given an isolated PATH with only the specified native lookup candidates.
    const directory = mkdtempSync(join(tmpdir(), 'context-shell-'));
    try {
      for (const shell of fixture.available) writeFileSync(join(directory, shell), '');
      const environment = { PATH: directory, SHELL: fixture.shell };
      // When building the real request context.
      const result = requestContextResult(
        { model: 'composer-2.5', messages: [{ role: 'user', content: 'WIRE_OK' }] },
        directory,
        environment,
      );
      // Then assert the machine-consumed shell enum, not prompt wording.
      const context = object(oneof(result.result).value.requestContext);
      expect(object(context.env).shell).toBe(fixture.expected);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
