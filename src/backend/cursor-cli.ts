import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { statSync } from 'node:fs';
import type {
  BackendHealth,
  BridgeModel,
  ChatCompletionRequest,
  CompletionResult,
  CursorBackend,
} from './types.js';
import { defaultCursorModels } from './mock.js';
import type { BridgeConfig } from '../config.js';

function validTimeoutMs(raw: string | undefined): number {
  const parsed = Number.parseInt(raw || '120000', 10);
  return Number.isFinite(parsed) && parsed >= 1_000 && parsed <= 600_000 ? parsed : 120_000;
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  stdinContent?: string,
): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: stdinContent === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
    });
    let settled = false;
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      if (!settled) {
        settled = true;
        reject(new Error(`cursor command timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr!.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code === 0) resolveOutput(stdout.trim());
      else reject(new Error(stderr.trim() || `cursor exited with code ${code ?? 'unknown'}`));
    });
    if (stdinContent !== undefined && child.stdin) {
      child.stdin.write(stdinContent, 'utf8');
      child.stdin.end();
    }
  });
}

function promptFromMessages(request: ChatCompletionRequest): string {
  return request.messages.map((msg) => `${msg.role.toUpperCase()}: ${msg.content}`).join('\n\n');
}

function assertWorkspace(path: string): string {
  const resolved = resolve(path);
  const info = statSync(resolved);
  if (!info.isDirectory()) throw new Error(`real workspace is not a directory: ${resolved}`);
  return resolved;
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function cursorCliArgs(
  cursorBin: string,
  request: ChatCompletionRequest,
  workspacePath: string,
): string[] {
  const baseArgs = [
    '--print',
    '--trust',
    '--mode',
    'ask',
    '--workspace',
    workspacePath,
    '--model',
    request.model,
    '--output-format',
    'text',
  ];
  return basename(cursorBin) === 'agent' ? baseArgs : ['agent', ...baseArgs];
}

export function createCursorCliBackend(config: BridgeConfig): CursorBackend {
  const cursorBin = process.env.CURSOR_BRIDGE_CURSOR_BIN || 'cursor';
  const timeoutMs = validTimeoutMs(process.env.CURSOR_BRIDGE_CURSOR_TIMEOUT_MS);

  async function workspace(): Promise<{ cwd: string; cleanup: () => Promise<void> }> {
    if (config.workspaceMode === 'real-workspace') {
      if (!config.realWorkspacePath) {
        throw new Error('CURSOR_BRIDGE_REAL_WORKSPACE is required for real-workspace mode');
      }
      return { cwd: assertWorkspace(config.realWorkspacePath), cleanup: async () => undefined };
    }
    const cwd = await mkdtemp(join(tmpdir(), 'cursor-ai-bridge-'));
    return { cwd, cleanup: async () => rm(cwd, { recursive: true, force: true }) };
  }

  return {
    type: 'cursor-cli',
    async health(): Promise<BackendHealth> {
      try {
        await runCommand(cursorBin, ['--version'], process.cwd(), 10_000);
        return {
          ok: true,
          type: 'cursor-cli',
          authConfigured: Boolean(process.env.CURSOR_AUTH_TOKEN || process.env.CURSOR_API_KEY),
          detail: `${cursorBin} available`,
        };
      } catch {
        return {
          ok: false,
          type: 'cursor-cli',
          authConfigured: Boolean(process.env.CURSOR_AUTH_TOKEN || process.env.CURSOR_API_KEY),
          detail: 'cursor cli unavailable',
        };
      }
    },
    async listModels(): Promise<BridgeModel[]> {
      const models = defaultCursorModels();
      const existingIds = new Set(models.map((m) => m.id));
      if (config.defaultModel && !existingIds.has(config.defaultModel)) {
        models.unshift({
          id: config.defaultModel,
          object: 'model',
          created: 1_700_000_000,
          owned_by: 'cursor',
        });
      }
      return models;
    },
    async complete(request: ChatCompletionRequest): Promise<CompletionResult> {
      const ws = await workspace();
      try {
        const prompt = promptFromMessages(request);
        const args = cursorCliArgs(cursorBin, request, ws.cwd);
        const output = await runCommand(cursorBin, args, ws.cwd, timeoutMs, prompt);
        const promptTokens = estimateTokens(prompt);
        const completionTokens = estimateTokens(output);
        return {
          content: output,
          model: request.model,
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
          },
        };
      } finally {
        await ws.cleanup();
      }
    },
  };
}
