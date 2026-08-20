import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';
import { parseTraceRecord } from './bridge-trace.js';

interface BarrierMessage {
  type?: unknown;
  id?: unknown;
}

const decoder = new StringDecoder('utf8');
let pending = '';
const forwardLine = (line: string): void => {
  if (!process.send || !line.trim()) return;
  try {
    const parsed = parseTraceRecord(JSON.parse(line) as unknown, 0);
    if (!parsed) return;
    const record: Record<string, unknown> = { ...parsed };
    delete record.sequence;
    process.send({ type: 'benchmark_trace_record', record });
  } catch {
    // Only validated safe trace records cross the benchmark IPC channel.
  }
};
const forwardChunk = (chunk: string | Uint8Array): void => {
  pending += decoder.write(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk));
  const lines = pending.split('\n');
  pending = lines.pop() ?? '';
  for (const line of lines) forwardLine(line.endsWith('\r') ? line.slice(0, -1) : line);
};

const originalWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = ((chunk: string | Uint8Array, ...args: unknown[]): boolean => {
  forwardChunk(chunk);
  return Reflect.apply(originalWrite, process.stderr, [chunk, ...args]) as boolean;
}) as typeof process.stderr.write;

process.on('message', (message: BarrierMessage) => {
  if (message.type !== 'benchmark_trace_barrier' || typeof message.id !== 'number') return;
  process.send?.({ type: 'benchmark_trace_barrier_done', id: message.id });
});

const entry = process.argv[2];
if (!entry) throw new Error('benchmark bridge child requires an entry module');
await import(pathToFileURL(entry).href);
