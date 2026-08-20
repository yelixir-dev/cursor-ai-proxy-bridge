import { CursorBackendError } from './cursor-cli-errors.js';
import type { CursorCommandRunner } from './cursor-cli-process.js';
import {
  assistantText,
  cursorUsage,
  estimatedUsage,
  parseCursorStreamObject,
} from './cursor-cli-result.js';
import type { CompletionStreamEvent } from './types.js';

class AsyncEventQueue<T> implements AsyncIterable<T>, AsyncIterator<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{
    readonly resolve: (result: IteratorResult<T>) => void;
    readonly reject: (error: unknown) => void;
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }
    const event = parseCursorStreamObject(parsed);
    if (!event) return;

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
    const reportedUsage = cursorUsage(event.usage);
    this.emit({
      type: 'done',
      usage: reportedUsage ?? estimatedUsage(this.prompt, resultText),
      usage_source: reportedUsage ? 'cli_reported' : 'estimated',
      is_error: isError,
      ...(message ? { message } : {}),
    });
    this.done = true;
  }
}

export type CursorStreamCommand = {
  readonly execute: CursorCommandRunner;
  readonly command: string;
  readonly args: string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly prompt: string;
  readonly signal?: AbortSignal;
};

export async function* cursorCompletionEvents(
  command: CursorStreamCommand,
): AsyncIterable<CompletionStreamEvent> {
  const queue = new AsyncEventQueue<CompletionStreamEvent>();
  const normalizer = new CursorStreamNormalizer(command.prompt, (event) => queue.push(event));
  let receivedCallback = false;
  const execution = command
    .execute(
      command.command,
      command.args,
      command.cwd,
      command.timeoutMs,
      command.prompt,
      command.signal,
      (chunk) => {
        receivedCallback = true;
        normalizer.push(chunk);
      },
    )
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
