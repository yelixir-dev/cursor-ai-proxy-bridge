import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createCursorCliBackend } from '../src/backend/cursor-cli.js';
import type { BridgeConfig } from '../src/config.js';

const baseConfig: BridgeConfig = {
  host: '127.0.0.1',
  port: 9997,
  apiKey: 'test-key',
  backend: 'cursor-cli',
  defaultModel: 'composer-2.5',
  workspaceMode: 'chat-only',
  realWorkspacePath: undefined,
  version: '0.1.0',
};

function cursorResult(
  result: string,
  usage: { inputTokens: number; outputTokens: number } | null = {
    inputTokens: 17,
    outputTokens: 5,
  },
): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result,
    ...(usage ? { usage } : {}),
  });
}

interface Invocation {
  argv: string[];
  cwd: string;
  stdin: string;
}

const readFileTool = {
  type: 'function' as const,
  function: {
    name: 'read_file',
    description: 'Read a file from disk',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
};

const terminalTool = {
  type: 'function' as const,
  function: {
    name: 'terminal',
    description: 'Run shell commands',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  },
};

describe('cursor cli backend', () => {
  beforeEach(() => {
    delete process.env.CURSOR_BRIDGE_CURSOR_BIN;
    delete process.env.CURSOR_BRIDGE_CURSOR_TIMEOUT_MS;
  });

  async function fakeCursorBin(output = cursorResult('BRIDGE_OK'), filename = 'fake-cursor.mjs') {
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

  async function failingCursorBin(filename = 'cursor-agent') {
    const dir = await mkdtemp(join(tmpdir(), 'cursor-ai-bridge-test-'));
    const binPath = join(dir, filename);
    await writeFile(
      binPath,
      `#!/usr/bin/env node
process.stderr.write('models unavailable');
process.exitCode = 1;
`,
      { mode: 0o755 },
    );
    process.env.CURSOR_BRIDGE_CURSOR_BIN = binPath;
  }

  async function readInvocations(logPath: string): Promise<Invocation[]> {
    return JSON.parse(await readFile(logPath, 'utf8')) as Invocation[];
  }

  it('invokes Cursor exactly once in JSON ask mode for chat-only requests', async () => {
    const { logPath } = await fakeCursorBin();
    const backend = createCursorCliBackend(baseConfig);

    const result = await backend.complete({
      model: 'composer-2.5',
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(result.content).toBe('BRIDGE_OK');
    const invocations = await readInvocations(logPath);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.argv).toEqual(
      expect.arrayContaining([
        'agent',
        '--print',
        '--trust',
        '--mode',
        'ask',
        '--model',
        'composer-2.5',
        '--output-format',
        'json',
      ]),
    );
    expect(invocations[0]?.argv).not.toContain('--force');
    expect(invocations[0]?.argv).not.toContain('--yolo');
    expect(invocations[0]?.stdin).toContain('USER: hello');
  });

  it.each(['agent', 'cursor-agent'])(
    'omits the cursor subcommand for standalone %s while retaining ask mode',
    async (filename) => {
      const { logPath } = await fakeCursorBin(cursorResult('BRIDGE_OK'), filename);
      const backend = createCursorCliBackend(baseConfig);

      await backend.complete({
        model: 'composer-2.5',
        messages: [{ role: 'user', content: 'hello agent binary' }],
      });

      const [invocation] = await readInvocations(logPath);
      expect(invocation?.argv.slice(0, 4)).toEqual(['--print', '--trust', '--mode', 'ask']);
      expect(invocation?.argv[0]).not.toBe('agent');
      expect(invocation?.argv).toEqual(expect.arrayContaining(['--output-format', 'json']));
    },
  );

  it('uses writable default agent mode only for explicit real-workspace requests', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'cursor-ai-bridge-real-workspace-'));
    const { logPath } = await fakeCursorBin();
    const backend = createCursorCliBackend({
      ...baseConfig,
      workspaceMode: 'real-workspace',
      realWorkspacePath: workspace,
    });

    await backend.complete({
      model: 'composer-2.5',
      messages: [{ role: 'user', content: 'work here' }],
    });

    const [invocation] = await readInvocations(logPath);
    expect(invocation?.argv).toEqual(expect.arrayContaining(['--workspace', workspace]));
    expect(invocation?.argv).not.toContain('--mode');
    expect(invocation?.argv).not.toContain('ask');
    expect(invocation?.argv).toEqual(expect.arrayContaining(['--output-format', 'json']));
  });

  it('includes tool definitions and strict marker instructions in the prompt', async () => {
    const { logPath } = await fakeCursorBin();
    const backend = createCursorCliBackend(baseConfig);

    await backend.complete({
      model: 'composer-2.5',
      messages: [{ role: 'user', content: 'read the file' }],
      tools: [readFileTool],
      tool_choice: 'auto',
    });

    const [invocation] = await readInvocations(logPath);
    expect(invocation?.stdin).toContain('AVAILABLE TOOLS');
    expect(invocation?.stdin).toContain('read_file');
    expect(invocation?.stdin).toContain('Read a file from disk');
    expect(invocation?.stdin).toContain('Tool choice mode: auto');
    expect(invocation?.stdin).toContain('[TOOL_CALLS:');
    expect(invocation?.stdin).toContain('Do not claim you used a tool in prose');
  });

  it('passes aggregate Cursor token usage through exactly', async () => {
    const { logPath } = await fakeCursorBin(
      cursorResult('usage result', {
        inputTokens: 123,
        outputTokens: 45,
      }),
    );
    const backend = createCursorCliBackend(baseConfig);

    const result = await backend.complete({
      model: 'composer-2.5',
      messages: [{ role: 'user', content: 'report usage' }],
    });

    expect(result.content).toBe('usage result');
    expect(result.usage).toEqual({
      prompt_tokens: 123,
      completion_tokens: 45,
      total_tokens: 168,
    });
    expect(await readInvocations(logPath)).toHaveLength(1);
  });

  it('parses the authoritative tool marker from the aggregate result in one invocation', async () => {
    const marker =
      '[TOOL_CALLS: [{"function":{"name":"read_file","arguments":{"path":"/model/chosen.txt"}}}]]';
    const { logPath } = await fakeCursorBin(
      cursorResult(marker, {
        inputTokens: 88,
        outputTokens: 12,
      }),
    );
    const backend = createCursorCliBackend(baseConfig);

    const result = await backend.complete({
      model: 'composer-2.5',
      messages: [{ role: 'user', content: 'read a file' }],
      tools: [readFileTool],
      tool_choice: 'auto',
    });

    expect(result.content).toBeNull();
    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls?.[0]?.function.name).toBe('read_file');
    expect(JSON.parse(result.tool_calls?.[0]?.function.arguments ?? '{}')).toEqual({
      path: '/model/chosen.txt',
    });
    expect(result.tool_calls?.[0]?.id).toMatch(/^call_bridge_[0-9a-f-]{36}$/);
    expect(result.usage).toEqual({ prompt_tokens: 88, completion_tokens: 12, total_tokens: 100 });
    const invocations = await readInvocations(logPath);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.argv).toEqual(expect.arrayContaining(['--output-format', 'json']));
  });

  it('retries schema-invalid marker arguments once in the same JSON mode', async () => {
    const invocations: Array<{ args: string[]; stdin?: string }> = [];
    const backend = createCursorCliBackend(baseConfig, {
      commandRunner: async (_command, args, _cwd, _timeoutMs, stdin) => {
        invocations.push({ args, stdin });
        return invocations.length === 1
          ? cursorResult(
              '[TOOL_CALLS: [{"function":{"name":"terminal","arguments":{"command":42}}}]]',
            )
          : cursorResult(
              '[TOOL_CALLS: [{"function":{"name":"terminal","arguments":{"command":"printf corrected"}}}]]',
              { inputTokens: 31, outputTokens: 9 },
            );
      },
    });

    const result = await backend.complete({
      model: 'composer-2.5',
      messages: [{ role: 'user', content: 'print corrected' }],
      tools: [terminalTool],
      tool_choice: 'auto',
    });

    expect(invocations).toHaveLength(2);
    expect(invocations[0]?.args).toEqual(expect.arrayContaining(['--output-format', 'json']));
    expect(invocations[1]?.args).toEqual(expect.arrayContaining(['--output-format', 'json']));
    expect(invocations[1]?.stdin).toContain('TOOL ARGUMENT VALIDATION FEEDBACK');
    expect(result.tool_calls?.[0]?.function.arguments).toBe('{"command":"printf corrected"}');
    expect(result.usage).toEqual({ prompt_tokens: 31, completion_tokens: 9, total_tokens: 40 });
  });

  it('falls back to malformed JSON stdout as plain text with estimated usage', async () => {
    const malformed = 'not-json assistant output';
    const { logPath } = await fakeCursorBin(malformed);
    const backend = createCursorCliBackend(baseConfig);

    const result = await backend.complete({
      model: 'composer-2.5',
      messages: [{ role: 'user', content: 'fallback please' }],
    });

    expect(result.content).toBe(malformed);
    expect(result.usage?.prompt_tokens).toBeGreaterThan(0);
    expect(result.usage?.completion_tokens).toBe(Math.ceil(malformed.length / 4));
    expect(result.usage?.total_tokens).toBe(
      (result.usage?.prompt_tokens ?? 0) + (result.usage?.completion_tokens ?? 0),
    );
    expect(await readInvocations(logPath)).toHaveLength(1);
  });

  it('falls back to estimated usage when an aggregate result omits usage', async () => {
    await fakeCursorBin(cursorResult('aggregate without usage', null));
    const backend = createCursorCliBackend(baseConfig);

    const result = await backend.complete({
      model: 'composer-2.5',
      messages: [{ role: 'user', content: 'estimate usage' }],
    });

    expect(result.content).toBe('aggregate without usage');
    expect(result.usage?.prompt_tokens).toBeGreaterThan(0);
    expect(result.usage?.completion_tokens).toBe(Math.ceil('aggregate without usage'.length / 4));
  });

  it('raises the Cursor result message when aggregate JSON reports is_error', async () => {
    const output = JSON.stringify({
      type: 'result',
      subtype: 'error',
      is_error: true,
      result: 'Cursor upstream quota exhausted',
    });
    const { logPath } = await fakeCursorBin(output);
    const backend = createCursorCliBackend(baseConfig);

    await expect(
      backend.complete({
        model: 'composer-2.5',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    ).rejects.toThrow('Cursor upstream quota exhausted');
    expect(await readInvocations(logPath)).toHaveLength(1);
  });

  it('uses one invocation for a tool-history follow-up that returns final text', async () => {
    const { logPath } = await fakeCursorBin(cursorResult('Final answer from tool result'));
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
      tools: [terminalTool],
      tool_choice: 'auto',
    });

    expect(result.content).toBe('Final answer from tool result');
    expect(result.tool_calls).toBeUndefined();
    const invocations = await readInvocations(logPath);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.stdin).toContain('TOOL RESULT (call_id=call_terminal_1): once');
    expect(invocations[0]?.argv).toEqual(expect.arrayContaining(['--output-format', 'json']));
  });

  it('uses one invocation for a sequential follow-up that emits the next tool marker', async () => {
    const secondMarker =
      '[TOOL_CALLS: [{"function":{"name":"terminal","arguments":{"command":"printf second"}}}]]';
    const invocations: string[] = [];
    const backend = createCursorCliBackend(baseConfig, {
      commandRunner: async (_command, _args, _cwd, _timeoutMs, stdin) => {
        invocations.push(stdin ?? '');
        return cursorResult(secondMarker);
      },
    });

    const result = await backend.complete({
      model: 'composer-2.5',
      messages: [
        { role: 'user', content: 'run first, then second' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_first',
              type: 'function',
              function: { name: 'terminal', arguments: '{"command":"printf first"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_first', content: 'first' },
      ],
      tools: [terminalTool],
      tool_choice: 'auto',
    });

    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toContain('TOOL RESULT (call_id=call_first): first');
    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls?.[0]?.function.arguments).toBe('{"command":"printf second"}');
  });

  it('enforces required and forced function choices on model-produced marker calls', async () => {
    const marker =
      '[TOOL_CALLS: [{"function":{"name":"terminal","arguments":{"command":"ignored"}}},{"function":{"name":"read_file","arguments":{"path":"forced.txt"}}}]]';
    await fakeCursorBin(cursorResult(marker));
    const backend = createCursorCliBackend(baseConfig);

    const result = await backend.complete({
      model: 'composer-2.5',
      messages: [{ role: 'user', content: 'read the file' }],
      tools: [terminalTool, readFileTool],
      tool_choice: { type: 'function', function: { name: 'read_file' } },
    });

    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls?.[0]?.function.name).toBe('read_file');
    expect(JSON.parse(result.tool_calls?.[0]?.function.arguments ?? '{}')).toEqual({
      path: 'forced.txt',
    });
  });

  it('fails when a required choice returns no marker', async () => {
    await fakeCursorBin(cursorResult('No tool call'));
    const backend = createCursorCliBackend(baseConfig);

    await expect(
      backend.complete({
        model: 'composer-2.5',
        messages: [{ role: 'user', content: 'read something' }],
        tools: [readFileTool],
        tool_choice: 'required',
      }),
    ).rejects.toThrow('Cursor did not return the required tool call');
  });

  it('treats tool_choice=none markers as plain content and omits tool instructions', async () => {
    const marker =
      '[TOOL_CALLS: [{"function":{"name":"read_file","arguments":{"path":"ignored"}}}]]';
    const { logPath } = await fakeCursorBin(cursorResult(marker));
    const backend = createCursorCliBackend(baseConfig);

    const result = await backend.complete({
      model: 'composer-2.5',
      messages: [{ role: 'user', content: 'answer without tools' }],
      tools: [readFileTool],
      tool_choice: 'none',
    });

    expect(result.content).toBe(marker);
    expect(result.tool_calls).toBeUndefined();
    const [invocation] = await readInvocations(logPath);
    expect(invocation?.stdin).not.toContain('AVAILABLE TOOLS');
    expect(invocation?.stdin).not.toContain('Tool choice mode');
  });

  it('returns at most one marker call when parallel_tool_calls=false', async () => {
    const marker =
      '[TOOL_CALLS: [{"function":{"name":"read_file","arguments":{"path":"one"}}},{"function":{"name":"read_file","arguments":{"path":"two"}}}]]';
    await fakeCursorBin(cursorResult(marker));
    const backend = createCursorCliBackend(baseConfig);

    const result = await backend.complete({
      model: 'composer-2.5',
      messages: [{ role: 'user', content: 'read two files' }],
      tools: [readFileTool],
      tool_choice: 'required',
      parallel_tool_calls: false,
    });

    expect(result.tool_calls).toHaveLength(1);
    expect(JSON.parse(result.tool_calls?.[0]?.function.arguments ?? '{}')).toEqual({ path: 'one' });
  });

  it('generates unique UUID-based ids for multiple marker calls', async () => {
    const marker =
      '[TOOL_CALLS: [{"function":{"name":"read_file","arguments":{"path":"one"}}},{"function":{"name":"read_file","arguments":{"path":"two"}}}]]';
    await fakeCursorBin(cursorResult(marker));
    const backend = createCursorCliBackend(baseConfig);

    const result = await backend.complete({
      model: 'composer-2.5',
      messages: [{ role: 'user', content: 'read two files' }],
      tools: [readFileTool],
      tool_choice: 'required',
    });

    const ids = result.tool_calls?.map((call) => call.id) ?? [];
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((id) => /^call_bridge_[0-9a-f-]{36}$/.test(id))).toBe(true);
  });

  it('maps developer messages to the same prompt role as system messages', async () => {
    const { logPath } = await fakeCursorBin();
    const backend = createCursorCliBackend(baseConfig);

    await backend.complete({
      model: 'composer-2.5',
      messages: [
        { role: 'developer', content: 'follow developer policy' },
        { role: 'user', content: 'hello' },
      ],
    });

    const [invocation] = await readInvocations(logPath);
    expect(invocation?.stdin).toContain('SYSTEM: follow developer policy');
    expect(invocation?.stdin).not.toContain('DEVELOPER:');
  });

  it('parses model ids with and without current markers and caches discovery', async () => {
    const { logPath } = await fakeCursorBin(
      [
        'composer-2.5 - Composer 2.5 (current)',
        'auto - Auto',
        'gpt-5.3-codex - GPT-5.3 Codex',
      ].join('\n'),
      'cursor-agent',
    );
    const backend = createCursorCliBackend(baseConfig);

    const first = await backend.listModels();
    const second = await backend.listModels();

    expect(first.map((model) => model.id)).toEqual(['composer-2.5', 'auto', 'gpt-5.3-codex']);
    expect(first.every((model) => model.object === 'model' && model.owned_by === 'cursor')).toBe(
      true,
    );
    expect(second).toEqual(first);
    const invocations = await readInvocations(logPath);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.argv).toEqual(['models']);
  });

  it('falls back to realistic static models when model output is empty', async () => {
    await fakeCursorBin(' \n', 'cursor-agent');
    const backend = createCursorCliBackend(baseConfig);

    const models = await backend.listModels();

    expect(models.map((model) => model.id)).toEqual(['composer-2.5', 'auto']);
  });

  it('falls back after model CLI failure and prepends a missing configured default', async () => {
    await failingCursorBin();
    const backend = createCursorCliBackend({ ...baseConfig, defaultModel: 'gpt-5.3-codex' });

    const models = await backend.listModels();

    expect(models.map((model) => model.id)).toEqual(['gpt-5.3-codex', 'composer-2.5', 'auto']);
  });
});
