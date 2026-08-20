#!/usr/bin/env tsx
/* global Buffer, console, process */
// Wire-capture normalizer: reads raw capture NDJSON records (see schema.md),
// decodes Connect frames with the repo protobuf codec, replaces
// non-deterministic values (UUIDs, timestamps, tokens, trace ids, blob ids)
// with stable first-occurrence placeholders, and emits schema_version 1
// normalized NDJSON. Run via tsx: `tsx scripts/wire-capture/normalize.mjs
// --in raw.ndjson --out normalized.ndjson`. Exit 1 when any error records
// were emitted; exit 2 on CLI/IO misuse. No network access.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { loadProtoDescriptors, ProtoCodec } from '../../src/backend/cursor-api/protobuf.js';

export const SCHEMA_VERSION = 1;

const CONNECT_FLAG_COMPRESSED = 0x01;
const CONNECT_FLAG_END_STREAM = 0x02;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRACEPARENT_RE = /^[\da-f]{2}-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/i;
const HEX_ID_RE = /^(?:0x)?[0-9a-f]{16,}$/i;
const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;
const TIME_FIELD_RE = /(timestamp|_at$|^at$|time|date)/i;

const REDACTED_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'x-apis-key',
  'x-blob-encryption-key',
  'x-client-key',
  'x-cursor-checksum',
  'x-cursor-privacy-mode',
  'traceparent',
]);

const MESSAGE_TYPE_BY_DIR = {
  client: 'agent.v1.AgentClientMessage',
  server: 'agent.v1.AgentServerMessage',
};

class Placeholders {
  constructor() {
    this.maps = new Map();
  }

  for(kind, value) {
    let map = this.maps.get(kind);
    if (!map) {
      map = new Map();
      this.maps.set(kind, map);
    }
    const existing = map.get(value);
    if (existing) return existing;
    const placeholder = `<${kind}:${map.size + 1}>`;
    map.set(value, placeholder);
    return placeholder;
  }
}

function sha256Hex(text) {
  return createHash('sha256').update(text).digest('hex');
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

function normalizeValue(value, fieldName, placeholders) {
  if (value === null || value === undefined) return value;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return placeholders.for('bytes', sha256Hex(Buffer.from(value)));
  }
  if (typeof value === 'bigint') {
    if (TIME_FIELD_RE.test(fieldName)) return '<ts>';
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
  }
  if (typeof value === 'number') {
    if (TIME_FIELD_RE.test(fieldName)) return '<ts>';
    return value;
  }
  if (typeof value === 'string') {
    if (UUID_RE.test(value)) return placeholders.for('uuid', value.toLowerCase());
    if (TRACEPARENT_RE.test(value)) return placeholders.for('trace', value.toLowerCase());
    if (ISO_TS_RE.test(value)) return '<ts>';
    if (HEX_ID_RE.test(value)) return placeholders.for('hex', value.toLowerCase());
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeValue(item, fieldName, placeholders));
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = normalizeValue(item, key, placeholders);
    }
    return out;
  }
  return value;
}

function normalizeHeaders(headers, placeholders) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    out[lower] = REDACTED_HEADERS.has(lower)
      ? '<redacted>'
      : normalizeValue(String(value), lower, placeholders);
  }
  return out;
}

function classifyDecodeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (
    /incorrect header check|unexpected end of file|invalid/i.test(message) &&
    /gzip|zlib|header/i.test(message)
  ) {
    return { kind: 'gzip_decode', message };
  }
  if (/truncated/.test(message)) return { kind: 'truncated_payload', message };
  return { kind: 'decode_error', message };
}

function normalizeLine(line, codec, placeholders) {
  let raw;
  try {
    raw = JSON.parse(line);
  } catch (error) {
    return {
      schema_version: SCHEMA_VERSION,
      lane: null,
      conn: null,
      stream: null,
      dir: null,
      frame_index: null,
      flags: null,
      message_type: null,
      headers: null,
      payload_sha256: null,
      decoded_fields: null,
      error: {
        kind: 'malformed_record',
        message: `invalid JSON line: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
  const record = raw && typeof raw === 'object' ? raw : {};
  const meta = {
    schema_version: SCHEMA_VERSION,
    lane: typeof record.lane === 'string' ? record.lane : null,
    conn: typeof record.conn === 'number' ? record.conn : null,
    stream: typeof record.stream === 'number' ? record.stream : null,
    dir: typeof record.dir === 'string' ? record.dir : null,
    frame_index: typeof record.frame_index === 'number' ? record.frame_index : null,
    flags: typeof record.flags === 'number' ? record.flags : null,
    message_type: typeof record.message_type === 'string' ? record.message_type : null,
    headers:
      record.headers && typeof record.headers === 'object'
        ? normalizeHeaders(record.headers, placeholders)
        : null,
  };
  const malformed = (message) => ({
    ...meta,
    payload_sha256: null,
    decoded_fields: null,
    error: { kind: 'malformed_record', message },
  });
  if (typeof record.payload_b64 !== 'string' || record.payload_b64 === '') {
    return malformed('missing payload_b64');
  }
  if (meta.flags === null) return malformed('missing flags');
  if (meta.dir === null) return malformed('missing dir');
  let payload;
  try {
    payload = Buffer.from(record.payload_b64, 'base64');
  } catch {
    return malformed('payload_b64 is not valid base64');
  }
  const messageType =
    meta.message_type ?? MESSAGE_TYPE_BY_DIR[meta.dir] ?? 'agent.v1.AgentClientMessage';
  try {
    if (meta.flags & CONNECT_FLAG_COMPRESSED) {
      try {
        payload = gunzipSync(payload);
      } catch (error) {
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
          __gzip: true,
        });
      }
    }
    let decoded;
    if (meta.flags & CONNECT_FLAG_END_STREAM) {
      decoded = { trailer: JSON.parse(payload.toString('utf8') || '{}') };
    } else {
      decoded = codec.decode(messageType, payload);
    }
    const normalized = normalizeValue(decoded, '', placeholders);
    return {
      ...meta,
      message_type: messageType,
      payload_sha256: sha256Hex(JSON.stringify(canonicalize(normalized))),
      decoded_fields: normalized,
    };
  } catch (error) {
    const classified =
      error && error.__gzip
        ? { kind: 'gzip_decode', message: error.message }
        : classifyDecodeError(error);
    return {
      ...meta,
      message_type: messageType,
      payload_sha256: null,
      decoded_fields: null,
      error: classified,
    };
  }
}

export function normalizeCapture(input) {
  const codec = new ProtoCodec(loadProtoDescriptors());
  const placeholders = new Placeholders();
  const records = [];
  for (const line of input.split('\n')) {
    if (line.trim() === '') continue;
    records.push(normalizeLine(line, codec, placeholders));
  }
  const output = records.map((record) => JSON.stringify(record)).join('\n') + '\n';
  const errorCount = records.filter((record) => record.error).length;
  return { output, records, errorCount };
}

function parseArgs(argv) {
  const args = { in: null, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--in') args.in = argv[i + 1];
    else if (argv[i] === '--out') args.out = argv[i + 1];
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.in || !args.out) {
    console.error(
      'usage: tsx scripts/wire-capture/normalize.mjs --in <raw.ndjson> --out <normalized.ndjson>',
    );
    process.exit(2);
  }
  let input;
  try {
    input = readFileSync(args.in, 'utf8');
  } catch (error) {
    console.error(
      `error: cannot read ${args.in}: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(2);
  }
  const result = normalizeCapture(input);
  writeFileSync(args.out, result.output);
  console.error(
    `normalized ${result.records.length} records, ${result.errorCount} error(s) -> ${args.out}`,
  );
  process.exit(result.errorCount > 0 ? 1 : 0);
}

const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) main();
