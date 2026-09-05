import { z } from 'zod';
import { awaitWithAbort } from './auth.js';
import type { NativeConversationContext } from './native-context.js';

const readSchema = z.object({
  path: z.string(),
  offset: z.number().int().min(-2_147_483_648).max(2_147_483_647).optional(),
  limit: z.number().int().min(0).max(4_294_967_295).optional(),
});
type NativeReadArgs = z.infer<typeof readSchema>;
type ReadDisposition =
  | { readonly kind: 'owned'; readonly args: NativeReadArgs }
  | { readonly kind: 'unowned' | 'invalid' };

/** Paths are checked before external-tool routing; no local filesystem is consulted. */
export function nativeReadDisposition(
  context: NativeConversationContext,
  value: unknown,
): ReadDisposition {
  const parsed = readSchema.safeParse(value);
  if (!parsed.success) return { kind: 'invalid' };
  try {
    return context.ownsPath(parsed.data.path)
      ? { kind: 'owned', args: parsed.data }
      : { kind: 'unowned' };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { kind: 'invalid' };
  }
}

/** Native CLI ReadArgs semantics, including negative tail offsets and the EOF fallback. */
export async function nativeReadResult(
  context: NativeConversationContext,
  args: NativeReadArgs,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const content = await awaitWithAbort(context.readFile(args.path, signal), signal);
  signal?.throwIfAborted();
  if (content === undefined) throw new Error('Declared native context file is unavailable');
  const lines = content.split('\n');
  const totalLines = lines.length;
  const offset = args.offset ?? 1;
  const start = offset < 0 ? Math.max(0, totalLines + offset) : Math.max(0, offset - 1);
  const rangeApplied =
    (args.offset !== undefined || args.limit !== undefined) && content !== '' && start < totalLines;
  const output = rangeApplied
    ? lines
        .slice(start, start + (args.limit ?? (offset < 0 ? Math.abs(offset) : totalLines)))
        .join('\n')
    : content;
  const fileSize = Buffer.byteLength(content);
  return {
    result: {
      case: 'success',
      value: {
        path: args.path,
        output: { case: 'content', value: output },
        totalLines,
        ...(fileSize ? { fileSize } : {}),
        ...(rangeApplied ? { rangeApplied: true } : {}),
      },
    },
  };
}

interface NativeReadExecution {
  readonly context: NativeConversationContext;
  readonly args: unknown;
  readonly signal?: AbortSignal;
  readonly reply: (result: Record<string, unknown>) => void;
  readonly finish: (error: unknown) => void;
}

/** Async context reads belong to the active Run, never to the external-tool hold store. */
export function serveNativeContextRead(options: NativeReadExecution): boolean {
  const read = nativeReadDisposition(options.context, options.args);
  switch (read.kind) {
    case 'unowned':
      return false;
    case 'invalid':
      options.reply({
        result: { case: 'rejected', value: { reason: 'Invalid native read path or range' } },
      });
      return true;
    case 'owned':
      void nativeReadResult(options.context, read.args, options.signal).then(
        (result) => {
          if (!options.signal?.aborted) options.reply(result);
        },
        () => {
          if (!options.signal?.aborted) {
            // Source errors may include private URLs or response bodies. No filesystem
            // error code or typed HTTP status is available here, so use native ReadError.
            options.reply({
              result: {
                case: 'error',
                value: {
                  path: read.args.path,
                  error: 'Unable to read native context source',
                },
              },
            });
          }
        },
      );
      return true;
  }
}
