import { debuglog } from 'node:util';

const debug = debuglog('cursor-bridge');

export interface ContentBoundaryDebug {
  readonly stage: 'cursor_upstream_delta' | 'openai_sse_delta';
  readonly requested_model: string;
  readonly reasoning_effort: string;
  readonly request_id: string;
  readonly chunk_index: number;
  readonly chunk_length: number;
  readonly cumulative_length: number;
  readonly starts_with_whitespace: boolean;
  readonly ends_with_whitespace: boolean;
}

export function contentBoundaryDebug(
  fields: Omit<
    ContentBoundaryDebug,
    'chunk_length' | 'starts_with_whitespace' | 'ends_with_whitespace'
  > & { readonly text: string },
): ContentBoundaryDebug {
  return {
    stage: fields.stage,
    requested_model: fields.requested_model,
    reasoning_effort: fields.reasoning_effort,
    request_id: fields.request_id,
    chunk_index: fields.chunk_index,
    chunk_length: fields.text.length,
    cumulative_length: fields.cumulative_length,
    starts_with_whitespace: /^\s/u.test(fields.text),
    ends_with_whitespace: /\s$/u.test(fields.text),
  };
}

export function logContentBoundary(fields: ContentBoundaryDebug): void {
  debug('content boundary %o', fields);
}
