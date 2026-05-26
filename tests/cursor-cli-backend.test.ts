import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createCursorCliBackend } from '../src/backend/cursor-cli.js';
import type { BridgeConfig } from '../src/config.js';

const baseConfig: BridgeConfig = {
  host: '127.0.0.1',
  port: 9994,
  apiKey: 'test-key',
  backend: 'cursor-cli',
  defaultModel: 'composer-2.5',
  workspaceMode: 'chat-only',
  realWorkspacePath: undefined,
  version: '0.1.0',
};

describe('cursor cli backend', () => {
  beforeEach(() => {
    delete process.env.CURSOR_BRIDGE_CURSOR_BIN;
    delete process.env.CURSOR_BRIDGE_CURSOR_TIMEOUT_MS;
  });

  async function fakeCursorBin(output = 'BRIDGE_OK', filename = 'fake-cursor.mjs') {
    const dir = await mkdtemp(join(tmpdir(), 'cursor-ai-bridge-test-'));
    const logPath = join(dir, 'invocation.json');
    const binPath = join(dir, filename);
    await writeFile(
      binPath,
      `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const stdin = readFileSync(0, 'utf8');
writeFileSync(${JSON.stringify(logPath)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), stdin }));
process.stdout.write(${JSON.stringify(output)});
`,
      { mode: 0o755 },
    );
    process.env.CURSOR_BRIDGE_CURSOR_BIN = binPath;
    return { logPath };
  }

  it('invokes Cursor CLI in trusted ask mode for headless chat completions', async () => {
    const { logPath } = await fakeCursorBin();
    const backend = createCursorCliBackend(baseConfig);

    await backend.complete({
      model: 'composer-2.5',
      messages: [{ role: 'user', content: 'hello' }],
    });

    const invocation = JSON.parse(await readFile(logPath, 'utf8')) as {
      argv: string[];
      stdin: string;
    };
    expect(invocation.argv).toEqual(
      expect.arrayContaining([
        'agent',
        '--print',
        '--trust',
        '--mode',
        'ask',
        '--model',
        'composer-2.5',
      ]),
    );
    expect(invocation.stdin).toContain('USER: hello');
  });

  it('omits the cursor subcommand when the configured binary is the standalone agent executable', async () => {
    const { logPath } = await fakeCursorBin('BRIDGE_OK', 'agent');
    const backend = createCursorCliBackend(baseConfig);

    await backend.complete({
      model: 'composer-2.5',
      messages: [{ role: 'user', content: 'hello agent binary' }],
    });

    const invocation = JSON.parse(await readFile(logPath, 'utf8')) as { argv: string[] };
    expect(invocation.argv.slice(0, 4)).toEqual(['--print', '--trust', '--mode', 'ask']);
    expect(invocation.argv).not.toContain('agent');
  });

  it('exposes the configured default model in model discovery', async () => {
    const backend = createCursorCliBackend(baseConfig);

    const models = await backend.listModels();

    expect(models.map((model) => model.id)).toContain('composer-2.5');
  });

  it('returns non-zero estimated token usage when Cursor CLI does not report usage', async () => {
    await fakeCursorBin('BRIDGE_OK');
    const backend = createCursorCliBackend(baseConfig);

    const result = await backend.complete({
      model: 'composer-2.5',
      messages: [{ role: 'user', content: 'hello bridge' }],
    });

    expect(result.usage?.prompt_tokens).toBeGreaterThan(0);
    expect(result.usage?.completion_tokens).toBeGreaterThan(0);
    expect(result.usage?.total_tokens).toBeGreaterThan(0);
  });
});
