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
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const stdin = readFileSync(0, 'utf8');
const invocation = { argv: process.argv.slice(2), cwd: process.cwd(), stdin };
const existing = existsSync(${JSON.stringify(logPath)}) ? JSON.parse(readFileSync(${JSON.stringify(logPath)}, 'utf8')) : [];
existing.push(invocation);
writeFileSync(${JSON.stringify(logPath)}, JSON.stringify(existing));
process.stdout.write(${JSON.stringify(output)});
`,
      { mode: 0o755 },
    );
    process.env.CURSOR_BRIDGE_CURSOR_BIN = binPath;
    return { logPath };
  }

  async function fakeCursorBinByOutputFormat(outputs: { text: string; streamJson: string }) {
    const dir = await mkdtemp(join(tmpdir(), 'cursor-ai-bridge-test-'));
    const logPath = join(dir, 'invocation.json');
    const binPath = join(dir, 'fake-cursor.mjs');
    await writeFile(
      binPath,
      `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const stdin = readFileSync(0, 'utf8');
const invocation = { argv, cwd: process.cwd(), stdin };
const existing = existsSync(${JSON.stringify(logPath)}) ? JSON.parse(readFileSync(${JSON.stringify(logPath)}, 'utf8')) : [];
existing.push(invocation);
writeFileSync(${JSON.stringify(logPath)}, JSON.stringify(existing));
const format = argv[argv.indexOf('--output-format') + 1];
process.stdout.write(format === 'stream-json' ? ${JSON.stringify(outputs.streamJson)} : ${JSON.stringify(outputs.text)});
`,
      { mode: 0o755 },
    );
    process.env.CURSOR_BRIDGE_CURSOR_BIN = binPath;
    return { logPath };
  }

  async function readInvocations(
    logPath: string,
  ): Promise<Array<{ argv: string[]; stdin: string }>> {
    return JSON.parse(await readFile(logPath, 'utf8')) as Array<{ argv: string[]; stdin: string }>;
  }

  it('invokes Cursor CLI without --mode for writable headless agent completions', async () => {
    const { logPath } = await fakeCursorBin();
    const backend = createCursorCliBackend(baseConfig);

    await backend.complete({
      model: 'composer-2.5',
      messages: [{ role: 'user', content: 'hello' }],
    });

    const [invocation] = await readInvocations(logPath);
    expect(invocation).toBeDefined();
    expect(invocation.argv).toEqual(
      expect.arrayContaining(['agent', '--print', '--trust', '--model', 'composer-2.5']),
    );
    expect(invocation.argv).not.toContain('--mode');
    expect(invocation.argv).not.toContain('ask');
    expect(invocation.stdin).toContain('USER: hello');
  });

  it.each(['agent', 'cursor-agent'])(
    'omits both --mode and the cursor subcommand when configured binary is standalone %s',
    async (filename) => {
      const { logPath } = await fakeCursorBin('BRIDGE_OK', filename);
      const backend = createCursorCliBackend(baseConfig);

      await backend.complete({
        model: 'composer-2.5',
        messages: [{ role: 'user', content: 'hello agent binary' }],
      });

      const [invocation] = await readInvocations(logPath);
      expect(invocation).toBeDefined();
      expect(invocation.argv.slice(0, 2)).toEqual(['--print', '--trust']);
      expect(invocation.argv[0]).not.toBe('agent');
      expect(invocation.argv).not.toContain('--mode');
      expect(invocation.argv).not.toContain('ask');
    },
  );

  it('includes tool definitions and strict tool-call output instructions in prompt when tools are provided', async () => {
    const { logPath } = await fakeCursorBin('BRIDGE_OK');
    const backend = createCursorCliBackend(baseConfig);

    await backend.complete({
      model: 'composer-2.5',
      messages: [{ role: 'user', content: 'read the file' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'read_file',
            description: 'Read a file from disk',
            parameters: { type: 'object', properties: { path: { type: 'string' } } },
          },
        },
      ],
      tool_choice: 'auto',
    });

    const [invocation] = await readInvocations(logPath);
    expect(invocation).toBeDefined();
    expect(invocation.stdin).toContain('AVAILABLE TOOLS');
    expect(invocation.stdin).toContain('read_file');
    expect(invocation.stdin).toContain('Read a file from disk');
    expect(invocation.stdin).toContain('Tool choice mode: auto');
    expect(invocation.stdin).toContain('CURSOR_BRIDGE_TOOL_CALL');
    expect(invocation.stdin).toContain('Do not claim you used a tool in prose');
  });

  it('converts Cursor JSON tool-call output into OpenAI tool_calls for auto tool choice', async () => {
    await fakeCursorBin(
      JSON.stringify({
        tool_calls: [
          {
            function: {
              name: 'write_file',
              arguments: { path: '/tmp/probe.txt', content: 'ok' },
            },
          },
        ],
      }),
    );
    const backend = createCursorCliBackend(baseConfig);

    const result = await backend.complete({
      model: 'composer-2.5',
      messages: [{ role: 'user', content: 'write /tmp/probe.txt' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'write_file',
            description: 'Write a file',
            parameters: {
              type: 'object',
              properties: { path: { type: 'string' }, content: { type: 'string' } },
            },
          },
        },
      ],
      tool_choice: 'auto',
    });

    expect(result.content).toBeNull();
    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls?.[0]?.type).toBe('function');
    expect(result.tool_calls?.[0]?.function.name).toBe('write_file');
    expect(JSON.parse(result.tool_calls?.[0]?.function.arguments ?? '{}')).toEqual({
      path: '/tmp/probe.txt',
      content: 'ok',
    });
  });

  it('captures Cursor stream-json tool_call.started before falling back to text output', async () => {
    const { logPath } = await fakeCursorBinByOutputFormat({
      streamJson:
        JSON.stringify({
          type: 'tool_call',
          subtype: 'started',
          tool_call: {
            id: 'tc_stream_1',
            name: 'shellToolCall',
            args: { command: 'printf stream-ok' },
          },
        }) + '\n',
      text: 'SHOULD_NOT_USE_TEXT_FALLBACK',
    });
    const backend = createCursorCliBackend(baseConfig);

    const result = await backend.complete({
      model: 'composer-2.5',
      messages: [{ role: 'user', content: 'print stream-ok' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'terminal',
            description: 'Run shell commands',
            parameters: { type: 'object', properties: { command: { type: 'string' } } },
          },
        },
      ],
      tool_choice: 'auto',
    });

    expect(result.content).toBeNull();
    expect(result.tool_calls?.[0]?.id).toBe('tc_stream_1');
    expect(result.tool_calls?.[0]?.function.name).toBe('terminal');
    expect(JSON.parse(result.tool_calls?.[0]?.function.arguments ?? '{}')).toEqual({
      command: 'printf stream-ok',
    });
    const invocations = await readInvocations(logPath);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.argv).toEqual(
      expect.arrayContaining(['--output-format', 'stream-json']),
    );
  });

  it('falls back to parsing [TOOL_CALLS] from text output when stream-json has no allowed call', async () => {
    const { logPath } = await fakeCursorBinByOutputFormat({
      streamJson: JSON.stringify({ type: 'assistant', message: 'no tool here' }) + '\n',
      text: '[TOOL_CALLS: [{"function":{"name":"terminal","arguments":{"command":"printf fallback-ok"}}}]]',
    });
    const backend = createCursorCliBackend(baseConfig);

    const result = await backend.complete({
      model: 'composer-2.5',
      messages: [{ role: 'user', content: 'print fallback-ok' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'terminal',
            description: 'Run shell commands',
            parameters: { type: 'object', properties: { command: { type: 'string' } } },
          },
        },
      ],
      tool_choice: 'auto',
    });

    expect(result.content).toBeNull();
    expect(result.tool_calls?.[0]?.function.name).toBe('terminal');
    expect(JSON.parse(result.tool_calls?.[0]?.function.arguments ?? '{}')).toEqual({
      command: 'printf fallback-ok',
    });
    const invocations = await readInvocations(logPath);
    expect(invocations).toHaveLength(2);
    expect(invocations[0]?.argv).toEqual(
      expect.arrayContaining(['--output-format', 'stream-json']),
    );
    expect(invocations[1]?.argv).toEqual(expect.arrayContaining(['--output-format', 'text']));
  });

  it('does not redelegate tool_choice=auto after tool results are present in history', async () => {
    const { logPath } = await fakeCursorBinByOutputFormat({
      streamJson:
        JSON.stringify({
          type: 'tool_call',
          subtype: 'started',
          tool_call: { name: 'shellToolCall', args: { command: 'printf SHOULD_NOT_REPEAT' } },
        }) + '\n',
      text: 'Final answer from tool result',
    });
    const backend = createCursorCliBackend(baseConfig);

    const result = await backend.complete({
      model: 'composer-2.5',
      messages: [
        { role: 'user', content: 'run printf once' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_terminal_1',
              type: 'function',
              function: { name: 'terminal', arguments: '{"command":"printf once"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_terminal_1', content: 'once' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'terminal',
            description: 'Run shell commands',
            parameters: { type: 'object', properties: { command: { type: 'string' } } },
          },
        },
      ],
      tool_choice: 'auto',
    });

    expect(result.content).toBe('Final answer from tool result');
    expect(result.tool_calls).toBeUndefined();
    const invocations = await readInvocations(logPath);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.argv).toEqual(expect.arrayContaining(['--output-format', 'text']));
    expect(invocations[0]?.argv).not.toContain('stream-json');
  });

  it('synthesizes OpenAI tool_calls for required tool_choice without invoking Cursor CLI', async () => {
    const { logPath } = await fakeCursorBin('SHOULD_NOT_RUN');
    const backend = createCursorCliBackend(baseConfig);

    const result = await backend.complete({
      model: 'composer-2.5',
      messages: [{ role: 'user', content: 'read /tmp/test.txt' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'read_file',
            description: 'Read a file from disk',
            parameters: { type: 'object', properties: { path: { type: 'string' } } },
          },
        },
      ],
      tool_choice: 'required',
    });

    expect(result.content).toBeNull();
    expect(result.tool_calls?.[0]?.type).toBe('function');
    expect(result.tool_calls?.[0]?.function.name).toBe('read_file');
    expect(JSON.parse(result.tool_calls?.[0]?.function.arguments ?? '{}')).toEqual({
      path: '/tmp/test.txt',
    });
    await expect(readFile(logPath, 'utf8')).rejects.toThrow();
  });

  it('synthesizes OpenAI tool_calls for forced function tool_choice', async () => {
    await fakeCursorBin('SHOULD_NOT_RUN');
    const backend = createCursorCliBackend(baseConfig);

    const result = await backend.complete({
      model: 'composer-2.5',
      messages: [{ role: 'user', content: 'read the file' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'read_file',
            description: 'Read a file from disk',
            parameters: { type: 'object', properties: { path: { type: 'string' } } },
          },
        },
      ],
      tool_choice: { type: 'function', function: { name: 'read_file' } },
    });

    expect(result.content).toBeNull();
    expect(result.tool_calls?.[0]?.function.name).toBe('read_file');
  });

  it('includes tool_call_id in prompt for tool result messages', async () => {
    const { logPath } = await fakeCursorBin('BRIDGE_OK');
    const backend = createCursorCliBackend(baseConfig);

    await backend.complete({
      model: 'composer-2.5',
      messages: [
        { role: 'user', content: 'read the file' },
        {
          role: 'tool',
          content: 'file contents here',
          tool_call_id: 'call_abc123',
        },
      ],
    });

    const [invocation] = await readInvocations(logPath);
    expect(invocation).toBeDefined();
    expect(invocation.stdin).toContain('TOOL RESULT (call_id=call_abc123): file contents here');
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
