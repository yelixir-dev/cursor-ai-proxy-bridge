#!/usr/bin/env node
/* global console, process */
// Wire-capture frame differ: aligns two normalized NDJSON captures
// (schema_version 1, see schema.md) by message-type sequence and reports
// structural deltas — missing/extra frames, field-presence diffs, ordering
// diffs — plus lifecycle-timing deltas from lifecycle.ndjson when provided.
// Structural equality after normalization only; no fuzzy similarity scoring,
// no network. Run: `node scripts/wire-capture/diff.mjs <a.ndjson> <b.ndjson>
// [--out report.json] [--lifecycle-a f] [--lifecycle-b f]`.
// Exit 0 on identical, exit 1 with a delta list on divergence, exit 2 on
// CLI/IO/malformed-input errors.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const CLIENT_ONEOF_CASES = new Map([
  ['runRequest', 'run_request'],
  ['execClientMessage', 'exec_client_message'],
  ['kvClientMessage', 'kv_client_message'],
  ['conversationAction', 'conversation_action'],
  ['interactionResponse', 'interaction_response'],
  ['clientHeartbeat', 'client_heartbeat'],
]);

const SERVER_ONEOF_CASES = new Map([
  ['interactionUpdate', 'interaction_update'],
  ['execServerMessage', 'exec_server_message'],
  ['conversationCheckpointUpdate', 'conversation_checkpoint_update'],
  ['kvServerMessage', 'kv_server_message'],
  ['interactionQuery', 'interaction_query'],
]);

export class DiffInputError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'DiffInputError';
    this.kind = kind;
  }
}

function camelToSnake(name) {
  return name.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
}

function frameKind(record) {
  if (record.error) return 'error';
  const dir = typeof record.dir === 'string' ? record.dir : 'unknown';
  const decoded = record.decoded_fields;
  if (decoded && typeof decoded === 'object') {
    if ('trailer' in decoded) return `${dir}:trailer`;
    const message = decoded.message;
    if (message && typeof message === 'object' && typeof message.case === 'string') {
      const table = dir === 'server' ? SERVER_ONEOF_CASES : CLIENT_ONEOF_CASES;
      const snake = table.get(message.case) ?? camelToSnake(message.case);
      return `${dir}:${snake}`;
    }
  }
  return `${dir}:unknown`;
}

function parseNdjson(input, label) {
  if (input.trim() === '') {
    throw new DiffInputError('empty_input', `${label}: input is empty (no NDJSON records)`);
  }
  const records = [];
  const lines = input.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      throw new DiffInputError(
        'malformed_ndjson',
        `${label}: line ${i + 1} is not valid JSON (truncated or corrupt capture): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new DiffInputError('malformed_ndjson', `${label}: line ${i + 1} is not a JSON object`);
    }
    records.push(record);
  }
  if (records.length === 0) {
    throw new DiffInputError('empty_input', `${label}: input is empty (no NDJSON records)`);
  }
  return records;
}

// Collect the set of field paths present in a decoded tree. Leaf values are
// tracked separately so presence diffs and value diffs stay distinct.
function collectPaths(value, prefix, paths, values) {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      collectPaths(value[i], `${prefix}[${i}]`, paths, values);
    }
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      collectPaths(item, prefix === '' ? key : `${prefix}.${key}`, paths, values);
    }
    return;
  }
  paths.add(prefix);
  values.set(prefix, value);
}

function pairFrames(framesA, framesB) {
  // Pair the i-th occurrence of each kind in A with the i-th in B. Unpaired
  // occurrences are missing (A only) or extra (B only) frames.
  const queuesB = new Map();
  framesB.forEach((frame, index) => {
    let queue = queuesB.get(frame.kind);
    if (!queue) {
      queue = [];
      queuesB.set(frame.kind, queue);
    }
    queue.push(index);
  });
  const pairs = [];
  const missing = [];
  framesA.forEach((frame, index) => {
    const queue = queuesB.get(frame.kind);
    if (queue && queue.length > 0) {
      const bIndex = queue.shift();
      pairs.push({ aIndex: index, bIndex, kind: frame.kind });
    } else {
      missing.push({ index, kind: frame.kind });
    }
  });
  const pairedB = new Set(pairs.map((pair) => pair.bIndex));
  const extra = framesB
    .map((frame, index) => ({ index, kind: frame.kind }))
    .filter((entry) => !pairedB.has(entry.index));
  return { pairs, missing, extra };
}

function detectOrdering(pairs, deltas) {
  let maxB = -1;
  for (const pair of pairs) {
    if (pair.bIndex < maxB) {
      deltas.push({
        type: 'ordering',
        kind: pair.kind,
        position_a: pair.aIndex,
        position_b: pair.bIndex,
        detail: `frame kind ${pair.kind} at a[${pair.aIndex}] aligns to b[${pair.bIndex}], out of sequence (expected after b[${maxB}])`,
      });
    } else {
      maxB = pair.bIndex;
    }
  }
}

function comparePairFields(recordA, recordB, pair, deltas) {
  if (recordA.payload_sha256 === recordB.payload_sha256) return;
  const pathsA = new Set();
  const pathsB = new Set();
  const valuesA = new Map();
  const valuesB = new Map();
  collectPaths(recordA.decoded_fields ?? null, '', pathsA, valuesA);
  collectPaths(recordB.decoded_fields ?? null, '', pathsB, valuesB);
  const onlyInA = [...pathsA].filter((path) => !pathsB.has(path)).sort();
  const onlyInB = [...pathsB].filter((path) => !pathsA.has(path)).sort();
  const valueMismatch = [...pathsA]
    .filter((path) => pathsB.has(path) && valuesA.get(path) !== valuesB.get(path))
    .sort();
  if (onlyInA.length === 0 && onlyInB.length === 0 && valueMismatch.length === 0) return;
  deltas.push({
    type: 'field_presence',
    kind: pair.kind,
    position_a: pair.aIndex,
    position_b: pair.bIndex,
    only_in_a: onlyInA,
    only_in_b: onlyInB,
    value_mismatch: valueMismatch,
    detail: `frame kind ${pair.kind} at a[${pair.aIndex}]/b[${pair.bIndex}] diverges structurally`,
  });
}

function diffLifecycle(lifecycleAInput, lifecycleBInput, deltas) {
  const eventsA = parseNdjson(lifecycleAInput, 'lifecycle-a');
  const eventsB = parseNdjson(lifecycleBInput, 'lifecycle-b');
  const eventKind = (event) => (typeof event.event === 'string' ? event.event : 'unknown');
  const framesA = eventsA.map((event) => ({ kind: eventKind(event) }));
  const framesB = eventsB.map((event) => ({ kind: eventKind(event) }));
  const { pairs, missing, extra } = pairFrames(framesA, framesB);
  for (const entry of missing) {
    deltas.push({
      type: 'missing_lifecycle_event',
      kind: entry.kind,
      capture: 'a',
      position: entry.index,
      detail: `lifecycle event ${entry.kind} at a[${entry.index}] has no counterpart in b`,
    });
  }
  for (const entry of extra) {
    deltas.push({
      type: 'extra_lifecycle_event',
      kind: entry.kind,
      capture: 'b',
      position: entry.index,
      detail: `lifecycle event ${entry.kind} at b[${entry.index}] has no counterpart in a`,
    });
  }
  const events = pairs.map((pair) => {
    const a = eventsA[pair.aIndex];
    const b = eventsB[pair.bIndex];
    const monoA = typeof a.mono_ms === 'number' ? a.mono_ms : null;
    const monoB = typeof b.mono_ms === 'number' ? b.mono_ms : null;
    return {
      event: pair.kind,
      position_a: pair.aIndex,
      position_b: pair.bIndex,
      mono_ms_a: monoA,
      mono_ms_b: monoB,
      delta_ms: monoA !== null && monoB !== null ? monoB - monoA : null,
    };
  });
  return { events };
}

// Same-kind reordering never surfaces as a pairing inversion (pairs are made
// by kind occurrence), so compare the ordered payload-hash sequence per kind:
// equal multiset, different order => ordering delta.
function detectSameKindReorders(framesA, framesB, recordsA, recordsB, deltas) {
  const hashesByKind = (frames, records) => {
    const map = new Map();
    frames.forEach((frame, index) => {
      const hash = records[index].payload_sha256;
      if (typeof hash !== 'string') return;
      let list = map.get(frame.kind);
      if (!list) {
        list = [];
        map.set(frame.kind, list);
      }
      list.push(hash);
    });
    return map;
  };
  const byA = hashesByKind(framesA, recordsA);
  const byB = hashesByKind(framesB, recordsB);
  for (const [kind, hashesA] of byA) {
    const hashesB = byB.get(kind);
    if (!hashesB || hashesA.length !== hashesB.length || hashesA.length < 2) continue;
    const sameOrder = hashesA.every((hash, i) => hash === hashesB[i]);
    if (sameOrder) continue;
    const sameMultiset = [...hashesA].sort().join(',') === [...hashesB].sort().join(',');
    if (!sameMultiset) continue;
    deltas.push({
      type: 'ordering',
      kind,
      detail: `frames of kind ${kind} appear in a different order between captures`,
    });
  }
}

export function diffCaptures(inputA, inputB, options = {}) {
  const recordsA = parseNdjson(inputA, 'capture-a');
  const recordsB = parseNdjson(inputB, 'capture-b');
  const framesA = recordsA.map((record) => ({ kind: frameKind(record) }));
  const framesB = recordsB.map((record) => ({ kind: frameKind(record) }));

  const deltas = [];
  recordsA.forEach((record, index) => {
    if (record.error) {
      deltas.push({
        type: 'error_record',
        capture: 'a',
        position: index,
        kind: record.error.kind,
        detail: `capture a[${index}] carries a normalizer error record: ${record.error.message}`,
      });
    }
  });
  recordsB.forEach((record, index) => {
    if (record.error) {
      deltas.push({
        type: 'error_record',
        capture: 'b',
        position: index,
        kind: record.error.kind,
        detail: `capture b[${index}] carries a normalizer error record: ${record.error.message}`,
      });
    }
  });

  const comparableA = recordsA
    .map((record, index) => ({ record, index }))
    .filter((entry) => !entry.record.error);
  const comparableB = recordsB
    .map((record, index) => ({ record, index }))
    .filter((entry) => !entry.record.error);
  const { pairs, missing, extra } = pairFrames(
    comparableA.map((entry) => ({ kind: framesA[entry.index].kind })),
    comparableB.map((entry) => ({ kind: framesB[entry.index].kind })),
  );
  for (const entry of missing) {
    const original = comparableA[entry.index].index;
    deltas.push({
      type: 'missing_frame',
      kind: entry.kind,
      capture: 'a',
      position: original,
      detail: `frame kind ${entry.kind} present in a[${original}] is missing from capture b`,
    });
  }
  for (const entry of extra) {
    const original = comparableB[entry.index].index;
    deltas.push({
      type: 'extra_frame',
      kind: entry.kind,
      capture: 'b',
      position: original,
      detail: `frame kind ${entry.kind} present in b[${original}] is absent from capture a`,
    });
  }
  detectOrdering(
    pairs.map((pair) => ({
      aIndex: comparableA[pair.aIndex].index,
      bIndex: comparableB[pair.bIndex].index,
      kind: pair.kind,
    })),
    deltas,
  );
  detectSameKindReorders(framesA, framesB, recordsA, recordsB, deltas);
  for (const pair of pairs) {
    comparePairFields(
      comparableA[pair.aIndex].record,
      comparableB[pair.bIndex].record,
      {
        aIndex: comparableA[pair.aIndex].index,
        bIndex: comparableB[pair.bIndex].index,
        kind: pair.kind,
      },
      deltas,
    );
  }

  let lifecycle;
  if (options.lifecycleA !== undefined && options.lifecycleB !== undefined) {
    lifecycle = diffLifecycle(options.lifecycleA, options.lifecycleB, deltas);
  }

  return {
    schema_version: 1,
    identical: deltas.length === 0,
    summary: {
      frames_a: recordsA.length,
      frames_b: recordsB.length,
      matched: pairs.length,
      missing: missing.length,
      extra: extra.length,
      delta_count: deltas.length,
    },
    deltas,
    ...(lifecycle ? { lifecycle } : {}),
  };
}

function humanSummary(report) {
  const lines = [];
  const s = report.summary;
  lines.push(
    `frames: a=${s.frames_a} b=${s.frames_b} matched=${s.matched} missing=${s.missing} extra=${s.extra}`,
  );
  if (report.identical) {
    lines.push('IDENTICAL: no structural deltas');
  } else {
    lines.push(`DIVERGENT: ${s.delta_count} delta(s)`);
    for (const delta of report.deltas) {
      lines.push(`  - ${delta.type} ${delta.kind}: ${delta.detail}`);
    }
  }
  return lines.join('\n');
}

function parseArgs(argv) {
  const args = { a: null, b: null, out: null, lifecycleA: null, lifecycleB: null };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') args.out = argv[i + 1];
    else if (argv[i] === '--lifecycle-a') args.lifecycleA = argv[i + 1];
    else if (argv[i] === '--lifecycle-b') args.lifecycleB = argv[i + 1];
    else positional.push(argv[i]);
  }
  args.a = positional[0] ?? null;
  args.b = positional[1] ?? null;
  return args;
}

function readInput(path, label) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw new DiffInputError(
      'io_error',
      `cannot read ${label} at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.a || !args.b) {
    console.error(
      'usage: node scripts/wire-capture/diff.mjs <a.ndjson> <b.ndjson> [--out report.json] [--lifecycle-a f] [--lifecycle-b f]',
    );
    process.exit(2);
  }
  try {
    const inputA = readInput(args.a, 'capture-a');
    const inputB = readInput(args.b, 'capture-b');
    const options = {};
    if (args.lifecycleA && args.lifecycleB) {
      options.lifecycleA = readInput(args.lifecycleA, 'lifecycle-a');
      options.lifecycleB = readInput(args.lifecycleB, 'lifecycle-b');
    }
    const report = diffCaptures(inputA, inputB, options);
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (args.out) writeFileSync(args.out, json);
    process.stdout.write(json);
    console.error(humanSummary(report));
    process.exit(report.identical ? 0 : 1);
  } catch (error) {
    if (error instanceof DiffInputError) {
      console.error(`diff error (${error.kind}): ${error.message}`);
      process.exit(2);
    }
    throw error;
  }
}

const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) main();
