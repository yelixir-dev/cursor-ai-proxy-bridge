import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type {
  BackendHealth,
  BridgeModel,
  ChatCompletionRequest,
  CompletionResult,
  CompletionStreamEvent,
  CompletionUsage,
  CursorBackend,
  ToolCall,
} from './types.js';
import { defaultCursorModels } from './mock.js';
import {
  filterToolCallsToAllowed,
  parseToolCallsFromText,
  toolDelegationPromptSuffix,
} from './tool-call-parse.js';
import type { BridgeConfig } from '../config.js';
import {
  ToolArgumentValidationError,
  type ToolArgumentValidationFailure,
  validateToolCallArguments,
} from './tool-arguments.js';

const DEFAULT_TERMINATION_GRACE_MS = 750;
const DEFAULT_MAX_OUTPUT_BYTES = 8_388_608;

function boundedInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function validTimeoutMs(raw: string | undefined): number {
  return boundedInteger(raw, 120_000, 1_000, 600_000);
}

export class CursorBackendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CursorBackendError';
  }
}

export class CursorCommandAbortedError extends Error {
  constructor(message = 'cursor command aborted') {
    super(message);
    this.name = 'AbortError';
  }
}

export function childEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const exactNames = new Set([
    'PATH',
    'HOME',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TMPDIR',
    'SHELL',
    'USER',
    'LOGNAME',
    'NODE_COMPILE_CACHE',
  ]);
  for (const name of (source.CURSOR_BRIDGE_CHILD_ENV_ALLOW ?? '').split(',')) {
    const trimmed = name.trim();
    if (trimmed) exactNames.add(trimmed);
  }

  const result: NodeJS.ProcessEnv = { NO_COLOR: '1' };
  for (const [name, value] of Object.entries(source)) {
    const allowedPrefix =
      name.startsWith('XDG_') || (name.startsWith('CURSOR_') && !name.startsWith('CURSOR_BRIDGE_'));
    if (value !== undefined && (exactNames.has(name) || allowedPrefix)) result[name] = value;
  }
  return result;
}

export type CursorCommandRunner = (
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  stdinContent?: string,
  signal?: AbortSignal,
  onStdout?: (chunk: string) => void,
) => Promise<string>;

export type CursorSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

type ChildSignal = NodeJS.Signals;

interface ManagedCommand {
  terminate(error: Error): Promise<void>;
}

export class CursorChildRegistry {
  private readonly commands = new Set<ManagedCommand>();

  add(command: ManagedCommand): void {
    this.commands.add(command);
  }

  delete(command: ManagedCommand): void {
    this.commands.delete(command);
  }

  async shutdown(): Promise<void> {
    const error = new CursorCommandAbortedError('cursor backend shutting down');
    await Promise.all([...this.commands].map((command) => command.terminate(error)));
  }

  get size(): number {
    return this.commands.size;
  }
}

function signalProcessGroup(child: ChildProcess, signal: ChildSignal): void {
  if (process.platform !== 'win32' && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // A test double or a child that exited between checks may not have a process group.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // A concurrent exit makes termination a no-op.
  }
}

export interface CursorCommandRunnerOptions {
  registry?: CursorChildRegistry;
  spawn?: CursorSpawn;
  env?: NodeJS.ProcessEnv;
  terminationGraceMs?: number;
  maxOutputBytes?: number;
  signalChild?: (child: ChildProcess, signal: ChildSignal) => void;
}

export function createCursorCommandRunner(
  options: CursorCommandRunnerOptions = {},
): CursorCommandRunner {
  const registry = options.registry ?? new CursorChildRegistry();
  const spawnCommand = options.spawn ?? spawn;
  const env = childEnvironment(options.env);
  const terminationGraceMs =
    options.terminationGraceMs ??
    boundedInteger(
      options.env?.CURSOR_BRIDGE_TERMINATION_GRACE_MS ??
        process.env.CURSOR_BRIDGE_TERMINATION_GRACE_MS,
      DEFAULT_TERMINATION_GRACE_MS,
      1,
      30_000,
    );
  const maxOutputBytes =
    options.maxOutputBytes ??
    boundedInteger(
      options.env?.CURSOR_BRIDGE_MAX_OUTPUT_BYTES ?? process.env.CURSOR_BRIDGE_MAX_OUTPUT_BYTES,
      DEFAULT_MAX_OUTPUT_BYTES,
      1,
      1_073_741_824,
    );
  const sendSignal = options.signalChild ?? signalProcessGroup;

  return (command, args, cwd, timeoutMs, stdinContent, signal, onStdout) =>
    new Promise((resolveOutput, reject) => {
      if (signal?.aborted) {
        reject(new CursorCommandAbortedError());
        return;
      }

      let child: ChildProcess;
      try {
        child = spawnCommand(command, args, {
          cwd,
          detached: process.platform !== 'win32',
          env,
          stdio: stdinContent === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
        });
      } catch (error) {
        reject(error);
        return;
      }

      let finished = false;
      let exited = false;
      let stdout = '';
      let stderr = '';
      let outputBytes = 0;
      const stdoutDecoder = new StringDecoder('utf8');
      let stdoutFinalized = false;
      let termination: Promise<void> | undefined;
      let resolveExit!: () => void;
      const exitPromise = new Promise<void>((resolveExitPromise) => {
        resolveExit = resolveExitPromise;
      });

      const finish = (error?: Error, output?: string) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        registry.delete(managed);
        if (error) reject(error);
        else resolveOutput(output ?? '');
      };

      const noteExit = () => {
        if (exited) return;
        exited = true;
        resolveExit();
        registry.delete(managed);
      };

      const waitForGraceOrExit = async () => {
        if (exited) return;
        let graceTimer: NodeJS.Timeout | undefined;
        await Promise.race([
          exitPromise,
          new Promise<void>((resolveGrace) => {
            graceTimer = setTimeout(resolveGrace, terminationGraceMs);
          }),
        ]);
        if (graceTimer) clearTimeout(graceTimer);
      };

      const terminate = (error: Error): Promise<void> => {
        if (termination) return termination;
        clearTimeout(timeout);
        termination = (async () => {
          sendSignal(child, 'SIGTERM');
          await waitForGraceOrExit();
          if (!exited) {
            sendSignal(child, 'SIGKILL');
            await exitPromise;
          }
          finish(error);
        })();
        return termination;
      };

      const managed: ManagedCommand = { terminate };
      const onAbort = () => {
        void terminate(new CursorCommandAbortedError());
      };
      const timeout = setTimeout(() => {
        void terminate(new Error(`cursor command timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const capture = (target: 'stdout' | 'stderr', chunk: Buffer | string) => {
        if (termination) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        outputBytes += buffer.byteLength;
        if (outputBytes > maxOutputBytes) {
          void terminate(new CursorBackendError('output limit exceeded'));
          return;
        }
        if (target === 'stdout') {
          const decoded = stdoutDecoder.write(buffer);
          stdout += decoded;
          if (decoded) onStdout?.(decoded);
        } else stderr += buffer.toString('utf8');
      };
      const finalizeStdout = () => {
        if (stdoutFinalized) return;
        stdoutFinalized = true;
        const decoded = stdoutDecoder.end();
        stdout += decoded;
        if (decoded) onStdout?.(decoded);
      };

      registry.add(managed);
      child.stdout?.on('data', (chunk: Buffer | string) => capture('stdout', chunk));
      child.stderr?.on('data', (chunk: Buffer | string) => capture('stderr', chunk));
      child.on('error', (error) => {
        noteExit();
        if (!termination) finish(error);
      });
      child.on('exit', noteExit);
      child.on('close', (code) => {
        noteExit();
        finalizeStdout();
        if (termination) return;
        if (code === 0) finish(undefined, stdout.trim());
        else finish(new Error(stderr.trim() || `cursor exited with code ${code ?? 'unknown'}`));
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();

      if (stdinContent !== undefined && child.stdin) {
        child.stdin.write(stdinContent, 'utf8');
        child.stdin.end();
      }
    });
}

function formatToolsBlock(request: ChatCompletionRequest): string {
  if (request.tool_choice === 'none') return '';
  return toolDelegationPromptSuffix(request.tools, {
    toolChoice: request.tool_choice,
    parallelToolCalls: request.parallel_tool_calls,
  });
}

export function promptFromMessages(request: ChatCompletionRequest): string {
  const toolsBlock = formatToolsBlock(request);
  const msgs = request.messages
    .map((msg) => {
      if (msg.role === 'tool') {
        return `TOOL RESULT (call_id=${msg.tool_call_id ?? 'unknown'}): ${msg.content}`;
      }
      const promptRole = msg.role === 'developer' ? 'system' : msg.role;
      let line = `${promptRole.toUpperCase()}: ${msg.content}`;
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        line += `\n[TOOL_CALLS: ${JSON.stringify(msg.tool_calls)}]`;
      }
      return line;
    })
    .join('\n\n');
  const toolChoiceNote =
    request.tool_choice && request.tool_choice !== 'none'
      ? `\n\nTool choice mode: ${typeof request.tool_choice === 'string' ? request.tool_choice : `force:${request.tool_choice.function.name}`}`
      : '';
  return toolsBlock + msgs + toolChoiceNote;
}

function enforceToolChoice(toolCalls: ToolCall[], request: ChatCompletionRequest): ToolCall[] {
  let allowed = filterToolCallsToAllowed(toolCalls, request.tools);
  const forcedName =
    typeof request.tool_choice === 'object' ? request.tool_choice.function.name : undefined;
  if (forcedName) {
    allowed = allowed.filter((call) => call.function.name === forcedName);
  }
  return request.parallel_tool_calls === false ? allowed.slice(0, 1) : allowed;
}

function parseCursorToolCallOutput(output: string, request: ChatCompletionRequest): ToolCall[] {
  return enforceToolChoice(parseToolCallsFromText(output), request);
}

interface CursorResultUsage {
  inputTokens?: unknown;
  outputTokens?: unknown;
}

interface CursorResultObject {
  is_error?: unknown;
  result?: unknown;
  message?: unknown;
  usage?: CursorResultUsage;
}

function cursorUsage(raw: CursorResultUsage | undefined): CompletionUsage | undefined {
  const promptTokens = raw?.inputTokens;
  const completionTokens = raw?.outputTokens;
  if (
    typeof promptTokens !== 'number' ||
    !Number.isFinite(promptTokens) ||
    promptTokens < 0 ||
    typeof completionTokens !== 'number' ||
    !Number.isFinite(completionTokens) ||
    completionTokens < 0
  ) {
    return undefined;
  }
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

function estimatedUsage(prompt: string, output: string): CompletionUsage {
  const promptTokens = estimateTokens(prompt);
  const completionTokens = estimateTokens(output);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

function parseCursorResult(
  output: string,
  prompt: string,
): { text: string; usage: CompletionUsage } {
  let parsed: CursorResultObject;
  try {
    const candidate: unknown = JSON.parse(output);
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      return { text: output, usage: estimatedUsage(prompt, output) };
    }
    parsed = candidate as CursorResultObject;
  } catch {
    return { text: output, usage: estimatedUsage(prompt, output) };
  }

  if (parsed.is_error === true) {
    const message =
      typeof parsed.result === 'string' && parsed.result.trim()
        ? parsed.result.trim()
        : typeof parsed.message === 'string' && parsed.message.trim()
          ? parsed.message.trim()
          : 'Cursor returned an error';
    throw new CursorBackendError(message);
  }
  if (typeof parsed.result !== 'string') {
    return { text: output, usage: estimatedUsage(prompt, output) };
  }
  return {
    text: parsed.result,
    usage: cursorUsage(parsed.usage) ?? estimatedUsage(prompt, parsed.result),
  };
}

interface CursorStreamObject {
  type?: unknown;
  subtype?: unknown;
  text?: unknown;
  result?: unknown;
  is_error?: unknown;
  usage?: CursorResultUsage;
  message?: unknown;
}

function assistantText(event: CursorStreamObject): string | undefined {
  if (!event.message || typeof event.message !== 'object') return undefined;
  const content = (event.message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((block) =>
      block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string'
        ? String((block as { text: string }).text)
        : '',
    )
    .join('');
  return text || undefined;
}

class AsyncEventQueue<T> implements AsyncIterable<T>, AsyncIterator<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
  }> = [];
  private ended = false;
  private failure: unknown;

  push(value: T): void {
    if (this.ended || this.failure !== undefined) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.values.push(value);
  }

  end(): void {
    if (this.ended || this.failure !== undefined) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ value: undefined, done: true });
  }

  fail(error: unknown): void {
    if (this.ended || this.failure !== undefined) return;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve({ value, done: false });
    if (this.failure !== undefined) return Promise.reject(this.failure);
    if (this.ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this;
  }
}

class CursorStreamNormalizer {
  private lineBuffer = '';
  private assistantEvents = 0;
  private pendingAssistant: string | undefined;
  private fragmentsSeen = false;
  done = false;

  constructor(
    private readonly prompt: string,
    private readonly emit: (event: CompletionStreamEvent) => void,
  ) {}

  push(chunk: string): void {
    this.lineBuffer += chunk;
    let newline = this.lineBuffer.indexOf('\n');
    while (newline >= 0) {
      this.parseLine(this.lineBuffer.slice(0, newline));
      this.lineBuffer = this.lineBuffer.slice(newline + 1);
      newline = this.lineBuffer.indexOf('\n');
    }
  }

  finish(): void {
    if (this.lineBuffer.trim()) this.parseLine(this.lineBuffer);
    this.lineBuffer = '';
  }

  private parseLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event: CursorStreamObject;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      event = parsed as CursorStreamObject;
    } catch {
      return;
    }

    if (event.type === 'thinking' && event.subtype === 'delta' && typeof event.text === 'string') {
      this.emit({ type: 'thinking', text: event.text });
      return;
    }
    if (event.type === 'assistant') {
      const text = assistantText(event);
      if (text === undefined) return;
      if (this.pendingAssistant !== undefined) {
        this.emit({ type: 'content', text: this.pendingAssistant });
        this.fragmentsSeen = true;
      }
      this.pendingAssistant = text;
      this.assistantEvents += 1;
      return;
    }
    if (event.type !== 'result') return;

    const resultText = typeof event.result === 'string' ? event.result : '';
    if (this.assistantEvents === 0 && resultText) {
      this.emit({ type: 'content', text: resultText });
    } else if (!this.fragmentsSeen && this.pendingAssistant !== undefined) {
      this.emit({ type: 'content', text: this.pendingAssistant });
    }
    this.pendingAssistant = undefined;
    const isError = event.is_error === true || event.subtype === 'error';
    const message = isError
      ? resultText.trim() ||
        (typeof event.message === 'string' && event.message.trim()
          ? event.message.trim()
          : 'Cursor returned an error')
      : undefined;
    this.emit({
      type: 'done',
      usage: cursorUsage(event.usage) ?? estimatedUsage(this.prompt, resultText),
      is_error: isError,
      ...(message ? { message } : {}),
    });
    this.done = true;
  }
}

async function* cursorCompletionEvents(
  executeCommand: CursorCommandRunner,
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  prompt: string,
  signal?: AbortSignal,
): AsyncIterable<CompletionStreamEvent> {
  const queue = new AsyncEventQueue<CompletionStreamEvent>();
  const normalizer = new CursorStreamNormalizer(prompt, (event) => queue.push(event));
  let receivedCallback = false;
  const execution = executeCommand(command, args, cwd, timeoutMs, prompt, signal, (chunk) => {
    receivedCallback = true;
    normalizer.push(chunk);
  })
    .then((output) => {
      if (!receivedCallback && output) normalizer.push(`${output}\n`);
      normalizer.finish();
      if (!normalizer.done) throw new CursorBackendError('Cursor stream ended without a result');
      queue.end();
    })
    .catch((error: unknown) => queue.fail(error));

  try {
    for await (const event of queue) yield event;
  } finally {
    await execution;
  }
}

function completionFromCapturedTools(
  request: ChatCompletionRequest,
  toolCalls: NonNullable<CompletionResult['tool_calls']>,
  usage: CompletionUsage,
): CompletionResult {
  return {
    content: null,
    model: request.model,
    tool_calls: toolCalls,
    usage,
  };
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

const MODEL_DISCOVERY_TIMEOUT_MS = 10_000;
const MODEL_CACHE_TTL_MS = 60_000;
const MODEL_CREATED = 1_700_000_000;

function cursorModelsArgs(cursorBin: string): string[] {
  const binName = basename(cursorBin);
  return binName === 'agent' || binName === 'cursor-agent' ? ['models'] : ['agent', 'models'];
}

function parseCursorModels(output: string): BridgeModel[] {
  const ids = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const separatorIndex = line.indexOf(' - ');
    if (separatorIndex <= 0) continue;
    const id = line.slice(0, separatorIndex).trim();
    if (id) ids.add(id);
  }
  return [...ids].map((id) => ({
    id,
    object: 'model',
    created: MODEL_CREATED,
    owned_by: 'cursor',
  }));
}

function choiceRequiresToolCall(request: ChatCompletionRequest): boolean {
  return request.tool_choice === 'required' || typeof request.tool_choice === 'object';
}

function cursorCliArgs(
  cursorBin: string,
  request: ChatCompletionRequest,
  workspacePath: string,
  workspaceMode: BridgeConfig['workspaceMode'],
  streaming = false,
): string[] {
  const baseArgs = [
    '--print',
    '--trust',
    ...(workspaceMode === 'chat-only' ? ['--mode', 'ask'] : []),
    '--workspace',
    workspacePath,
    '--model',
    request.model,
    '--output-format',
    streaming ? 'stream-json' : 'json',
    ...(streaming ? ['--stream-partial-output'] : []),
  ];
  const binName = basename(cursorBin);
  return binName === 'agent' || binName === 'cursor-agent' ? baseArgs : ['agent', ...baseArgs];
}

function toolValidationFeedback(failure: ToolArgumentValidationFailure): string {
  return `\n\n--- TOOL ARGUMENT VALIDATION FEEDBACK ---\nYour previous call to ${JSON.stringify(failure.toolName)} was invalid: ${failure.message}. Return a corrected tool call whose arguments match the declared schema.\n--- END TOOL ARGUMENT VALIDATION FEEDBACK ---`;
}

interface WorkspaceWaiter {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

class WorkspaceMutex {
  private held = false;
  private readonly waiters: WorkspaceWaiter[] = [];

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new CursorCommandAbortedError();
    if (!this.held) {
      this.held = true;
      return this.releaseFunction();
    }

    return new Promise<() => void>((resolveWaiter, reject) => {
      const waiter: WorkspaceWaiter = { resolve: resolveWaiter, reject, signal };
      waiter.onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new CursorCommandAbortedError());
      };
      signal?.addEventListener('abort', waiter.onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  get idle(): boolean {
    return !this.held && this.waiters.length === 0;
  }

  private releaseFunction(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) {
        if (next.onAbort) next.signal?.removeEventListener('abort', next.onAbort);
        next.resolve(this.releaseFunction());
      } else {
        this.held = false;
      }
    };
  }
}

const workspaceMutexes = new Map<string, WorkspaceMutex>();

async function acquireWorkspaceMutex(path: string, signal?: AbortSignal): Promise<() => void> {
  let mutex = workspaceMutexes.get(path);
  if (!mutex) {
    mutex = new WorkspaceMutex();
    workspaceMutexes.set(path, mutex);
  }
  try {
    const release = await mutex.acquire(signal);
    return () => {
      release();
      if (mutex?.idle) workspaceMutexes.delete(path);
    };
  } catch (error) {
    if (mutex.idle) workspaceMutexes.delete(path);
    throw error;
  }
}

export interface CursorCliBackendDependencies {
  commandRunner?: CursorCommandRunner;
  spawn?: CursorSpawn;
  environment?: NodeJS.ProcessEnv;
  terminationGraceMs?: number;
  maxOutputBytes?: number;
  signalChild?: (child: ChildProcess, signal: ChildSignal) => void;
}

export function createCursorCliBackend(
  config: BridgeConfig,
  dependencies: CursorCliBackendDependencies = {},
): CursorBackend {
  const environment = dependencies.environment ?? process.env;
  const childRegistry = new CursorChildRegistry();
  const executeCommand =
    dependencies.commandRunner ??
    createCursorCommandRunner({
      registry: childRegistry,
      spawn: dependencies.spawn,
      env: environment,
      terminationGraceMs: dependencies.terminationGraceMs,
      maxOutputBytes: dependencies.maxOutputBytes,
      signalChild: dependencies.signalChild,
    });
  const cursorBin = environment.CURSOR_BRIDGE_CURSOR_BIN || 'cursor';
  const timeoutMs = validTimeoutMs(environment.CURSOR_BRIDGE_CURSOR_TIMEOUT_MS);
  let modelCache: { expiresAt: number; models: BridgeModel[] } | undefined;
  let modelRefresh: Promise<BridgeModel[]> | undefined;

  async function discoverModels(): Promise<BridgeModel[]> {
    let models: BridgeModel[];
    try {
      const output = await executeCommand(
        cursorBin,
        cursorModelsArgs(cursorBin),
        process.cwd(),
        MODEL_DISCOVERY_TIMEOUT_MS,
      );
      models = parseCursorModels(output);
      if (models.length === 0) models = defaultCursorModels();
    } catch {
      models = defaultCursorModels();
    }

    if (config.defaultModel && !models.some((model) => model.id === config.defaultModel)) {
      models.unshift({
        id: config.defaultModel,
        object: 'model',
        created: MODEL_CREATED,
        owned_by: 'cursor',
      });
    }
    modelCache = { expiresAt: Date.now() + MODEL_CACHE_TTL_MS, models };
    return models;
  }

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
        await executeCommand(cursorBin, ['--version'], process.cwd(), 10_000);
        return {
          ok: true,
          type: 'cursor-cli',
          authConfigured: Boolean(environment.CURSOR_AUTH_TOKEN || environment.CURSOR_API_KEY),
          detail: `${cursorBin} available`,
        };
      } catch {
        return {
          ok: false,
          type: 'cursor-cli',
          authConfigured: Boolean(environment.CURSOR_AUTH_TOKEN || environment.CURSOR_API_KEY),
          detail: 'cursor cli unavailable',
        };
      }
    },
    async listModels(): Promise<BridgeModel[]> {
      if (modelCache && modelCache.expiresAt > Date.now()) return [...modelCache.models];
      if (!modelRefresh) {
        modelRefresh = discoverModels().finally(() => {
          modelRefresh = undefined;
        });
      }
      return [...(await modelRefresh)];
    },
    async *completeStream(
      request: ChatCompletionRequest,
      signal?: AbortSignal,
    ): AsyncIterable<CompletionStreamEvent> {
      const ws = await workspace();
      let releaseWorkspace: (() => void) | undefined;
      try {
        if (config.workspaceMode === 'real-workspace') {
          releaseWorkspace = await acquireWorkspaceMutex(ws.cwd, signal);
        }
        const prompt = promptFromMessages(request);
        const args = cursorCliArgs(cursorBin, request, ws.cwd, config.workspaceMode, true);
        const stream = (streamPrompt: string) =>
          cursorCompletionEvents(
            executeCommand,
            cursorBin,
            args,
            ws.cwd,
            timeoutMs,
            streamPrompt,
            signal,
          );

        if (!request.tools || request.tools.length === 0) {
          for await (const event of stream(prompt)) yield event;
          return;
        }

        const collect = async (streamPrompt: string) => {
          let text = '';
          let usage: CompletionUsage | undefined;
          for await (const event of stream(streamPrompt)) {
            if (event.type === 'content') text += event.text;
            if (event.type === 'done') {
              if (event.is_error)
                throw new CursorBackendError(event.message ?? 'Cursor returned an error');
              usage = event.usage;
            }
          }
          if (!usage) throw new CursorBackendError('Cursor stream ended without usage');
          return { text, usage };
        };

        let output = await collect(prompt);
        if (request.tool_choice !== 'none') {
          const calls = parseCursorToolCallOutput(output.text, request);
          if (calls.length > 0) {
            const failure = validateToolCallArguments(calls, request.tools);
            if (failure) {
              const retryPrompt = prompt + toolValidationFeedback(failure);
              output = await collect(retryPrompt);
              const retryCalls = parseCursorToolCallOutput(output.text, request);
              if (retryCalls.length === 0) {
                throw new ToolArgumentValidationError({
                  toolName: failure.toolName,
                  message: `${failure.message}; retry did not return a corrected tool call`,
                });
              }
              const retryFailure = validateToolCallArguments(retryCalls, request.tools);
              if (retryFailure) throw new ToolArgumentValidationError(retryFailure);
            }
          } else if (choiceRequiresToolCall(request)) {
            throw new Error('Cursor did not return the required tool call');
          }
        }
        if (output.text) yield { type: 'content', text: output.text };
        yield { type: 'done', usage: output.usage, is_error: false };
      } finally {
        releaseWorkspace?.();
        await ws.cleanup();
      }
    },
    async complete(
      request: ChatCompletionRequest,
      signal?: AbortSignal,
    ): Promise<CompletionResult> {
      const ws = await workspace();
      let releaseWorkspace: (() => void) | undefined;
      try {
        if (config.workspaceMode === 'real-workspace') {
          releaseWorkspace = await acquireWorkspaceMutex(ws.cwd, signal);
        }
        const prompt = promptFromMessages(request);
        const args = cursorCliArgs(cursorBin, request, ws.cwd, config.workspaceMode);

        const validateAndComplete = async (
          toolCalls: ToolCall[],
          usage: CompletionUsage,
        ): Promise<CompletionResult | undefined> => {
          if (toolCalls.length === 0) return undefined;
          const failure = validateToolCallArguments(toolCalls, request.tools);
          if (!failure) return completionFromCapturedTools(request, toolCalls, usage);

          const retryPrompt = prompt + toolValidationFeedback(failure);
          const retryRawOutput = await executeCommand(
            cursorBin,
            args,
            ws.cwd,
            timeoutMs,
            retryPrompt,
            signal,
          );
          const retryOutput = parseCursorResult(retryRawOutput, retryPrompt);
          const retryCalls = parseCursorToolCallOutput(retryOutput.text, request);
          if (retryCalls.length === 0) {
            throw new ToolArgumentValidationError({
              toolName: failure.toolName,
              message: `${failure.message}; retry did not return a corrected tool call`,
            });
          }
          const retryFailure = validateToolCallArguments(retryCalls, request.tools);
          if (retryFailure) throw new ToolArgumentValidationError(retryFailure);
          return completionFromCapturedTools(request, retryCalls, retryOutput.usage);
        };

        const rawOutput = await executeCommand(cursorBin, args, ws.cwd, timeoutMs, prompt, signal);
        const output = parseCursorResult(rawOutput, prompt);
        if (request.tool_choice !== 'none') {
          const toolCompletion = await validateAndComplete(
            parseCursorToolCallOutput(output.text, request),
            output.usage,
          );
          if (toolCompletion) return toolCompletion;
          if (choiceRequiresToolCall(request)) {
            throw new Error('Cursor did not return the required tool call');
          }
        }
        return {
          content: output.text || null,
          model: request.model,
          usage: output.usage,
        };
      } finally {
        releaseWorkspace?.();
        await ws.cleanup();
      }
    },
    async shutdown(): Promise<void> {
      await childRegistry.shutdown();
    },
  };
}
