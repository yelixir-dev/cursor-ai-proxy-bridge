export const TOOL_CALL_MARKER = '[TOOL_CALLS:';
const TOOL_JSON_KEYS = new Set(['tool_calls', 'function_call']);

type CandidateClassification = 'stream' | 'suppress' | 'wait';

function classifyJsonObject(candidate: string): CandidateClassification {
  if (!candidate.startsWith('{')) return 'stream';
  let index = 1;
  while (index < candidate.length && /\s/.test(candidate[index] ?? '')) index += 1;
  if (index >= candidate.length) return 'wait';
  if (candidate[index] !== '"') return 'stream';

  const keyStart = index;
  index += 1;
  let escaped = false;
  for (; index < candidate.length; index += 1) {
    const character = candidate[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character !== '"') continue;

    const encodedKey = candidate.slice(keyStart, index + 1);
    index += 1;
    while (index < candidate.length && /\s/.test(candidate[index] ?? '')) index += 1;
    if (index >= candidate.length) return 'wait';
    if (candidate[index] !== ':') return 'stream';
    try {
      const key = JSON.parse(encodedKey) as unknown;
      return typeof key === 'string' && TOOL_JSON_KEYS.has(key) ? 'suppress' : 'stream';
    } catch {
      return 'stream';
    }
  }
  return 'wait';
}

function classifyLeadingCandidate(
  candidate: string,
  inspectToolJson: boolean,
): CandidateClassification {
  if (TOOL_CALL_MARKER.startsWith(candidate)) {
    return candidate.length < TOOL_CALL_MARKER.length ? 'wait' : 'suppress';
  }
  if (candidate.startsWith(TOOL_CALL_MARKER)) return 'suppress';
  if (!inspectToolJson) return 'stream';

  let jsonCandidate = candidate;
  if (jsonCandidate.startsWith('`')) {
    if (!jsonCandidate.startsWith('```')) {
      return jsonCandidate.length < 3 ? 'wait' : 'stream';
    }
    let fencedContent = jsonCandidate.slice(3);
    if (!fencedContent) return 'wait';
    const lowerFencedContent = fencedContent.toLowerCase();
    if ('json'.startsWith(lowerFencedContent)) return 'wait';
    if (lowerFencedContent.startsWith('json')) {
      const separator = fencedContent[4];
      if (separator === undefined) return 'wait';
      if (separator !== '{' && !/\s/.test(separator)) return 'stream';
      fencedContent = fencedContent.slice(4);
    } else if (!fencedContent.startsWith('{') && !/^\s/.test(fencedContent)) {
      return 'stream';
    }
    jsonCandidate = fencedContent.trimStart();
    if (!jsonCandidate) return 'wait';
  }
  return classifyJsonObject(jsonCandidate);
}

export class ToolTextStreamFilter {
  private pending = '';
  private mode: 'undecided' | 'streaming' | 'suppressed' = 'undecided';

  constructor(private readonly inspectToolJson = false) {}

  get suppressedToolPayload(): boolean {
    return this.mode === 'suppressed';
  }

  push(text: string): string {
    if (this.mode === 'suppressed') return '';
    this.pending += text;

    if (this.mode === 'undecided') {
      const candidate = this.pending.trimStart();
      if (!candidate) return '';
      const classification = classifyLeadingCandidate(candidate, this.inspectToolJson);
      if (classification === 'wait') return '';
      if (classification === 'suppress') {
        this.mode = 'suppressed';
        this.pending = '';
        return '';
      }
      this.mode = 'streaming';
    }

    const markerIndex = this.pending.indexOf(TOOL_CALL_MARKER);
    if (markerIndex >= 0) {
      this.mode = 'suppressed';
      const safe = this.pending.slice(0, markerIndex);
      this.pending = '';
      return safe;
    }

    let held = 0;
    const maximum = Math.min(this.pending.length, TOOL_CALL_MARKER.length - 1);
    for (let length = maximum; length > 0; length -= 1) {
      if (TOOL_CALL_MARKER.startsWith(this.pending.slice(-length))) {
        held = length;
        break;
      }
    }
    const safe = this.pending.slice(0, this.pending.length - held);
    this.pending = this.pending.slice(this.pending.length - held);
    return safe;
  }

  finish(): string {
    if (this.mode === 'suppressed') return '';
    const safe = this.pending;
    this.pending = '';
    return safe;
  }
}
