import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  CONNECT_FLAG_COMPRESSED,
  encodeConnectFrame,
} from '../src/backend/cursor-api/connect-frame.js';
import { loadProtoDescriptors, ProtoCodec } from '../src/backend/cursor-api/protobuf.js';
import { normalizeCapture } from '../scripts/wire-capture/normalize.mjs';

const codec = new ProtoCodec(loadProtoDescriptors());

const UUID_A = '11111111-2222-4333-8444-555555555555';
const UUID_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const UUID_C = '99999999-8888-4777-8666-555554444444';
const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

interface RawRecord {
  lane: string;
  conn: number;
  stream: number;
  dir: 'client' | 'server';
  frame_index: number;
  flags: number;
  payload_b64: string;
  message_type?: string;
  headers?: Record<string, string>;
}

function clientMessage(messageCase: string, value: Record<string, unknown>): Buffer {
  return codec.encode('agent.v1.AgentClientMessage', {
    message: { case: messageCase, value },
  });
}

function rawRecord(payload: Buffer, overrides: Partial<RawRecord> = {}): RawRecord {
  const frame = encodeConnectFrame(payload);
  return {
    lane: 'native',
    conn: 1,
    stream: 3,
    dir: 'client',
    frame_index: 0,
    flags: frame[0] ?? 0,
    payload_b64: frame.subarray(5).toString('base64'),
    message_type: 'agent.v1.AgentClientMessage',
    ...overrides,
  };
}

function rawLine(record: RawRecord): string {
  return JSON.stringify(record);
}

function runRequestFrame(conversationId: string, runId: string): Buffer {
  return clientMessage('runRequest', { conversationId, runId });
}

function heartbeatFrame(): Buffer {
  return clientMessage('clientHeartbeat', {});
}

function execFrame(execId: string, localExecutionTimeMs: number): Buffer {
  return clientMessage('execClientMessage', { id: 7, execId, localExecutionTimeMs });
}

function syntheticCapture(conversationId: string, runId: string, execId: string): string {
  const headers = {
    authorization: 'Bearer secret-token-value',
    'x-blob-encryption-key': '0123456789abcdef0123456789abcdef',
    traceparent: TRACEPARENT,
    'content-type': 'application/connect+proto',
  };
  return [
    rawLine(rawRecord(runRequestFrame(conversationId, runId), { frame_index: 0, headers })),
    rawLine(rawRecord(heartbeatFrame(), { frame_index: 1 })),
    rawLine(rawRecord(execFrame(execId, 1724000000123), { frame_index: 2 })),
  ].join('\n');
}

describe('wire-capture normalizer', () => {
  it('decodes Connect frames into decoded field trees with the oneof case', () => {
    const input = syntheticCapture(UUID_A, UUID_B, UUID_C);
    const result = normalizeCapture(input);
    expect(result.errorCount).toBe(0);
    expect(result.records).toHaveLength(3);
    const first = result.records[0];
    expect(first?.schema_version).toBe(1);
    expect(first?.lane).toBe('native');
    expect(first?.stream).toBe(3);
    expect(first?.dir).toBe('client');
    expect(first?.frame_index).toBe(0);
    const decoded = first?.decoded_fields as {
      message: { case: string; value: Record<string, unknown> };
    };
    expect(decoded.message.case).toBe('runRequest');
    expect(typeof first?.payload_sha256).toBe('string');
    expect(first?.payload_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('replaces UUIDs with stable first-occurrence placeholders shared across fields', () => {
    const input = syntheticCapture(UUID_A, UUID_B, UUID_A);
    const result = normalizeCapture(input);
    const first = result.records[0]?.decoded_fields as {
      message: { value: { conversationId: string; runId: string } };
    };
    const third = result.records[2]?.decoded_fields as {
      message: { value: { execId: string } };
    };
    expect(first.message.value.conversationId).toBe('<uuid:1>');
    expect(first.message.value.runId).toBe('<uuid:2>');
    // Same logical UUID in a later frame reuses the same placeholder.
    expect(third.message.value.execId).toBe('<uuid:1>');
  });

  it('normalizes timestamps by field name', () => {
    const input = syntheticCapture(UUID_A, UUID_B, UUID_C);
    const result = normalizeCapture(input);
    const exec = result.records[2]?.decoded_fields as {
      message: { value: { localExecutionTimeMs: unknown } };
    };
    expect(exec.message.value.localExecutionTimeMs).toBe('<ts>');
  });

  it('redacts sensitive headers but keeps structural headers', () => {
    const input = syntheticCapture(UUID_A, UUID_B, UUID_C);
    const result = normalizeCapture(input);
    const headers = result.records[0]?.headers as Record<string, string>;
    expect(headers.authorization).toBe('<redacted>');
    expect(headers['x-blob-encryption-key']).toBe('<redacted>');
    expect(headers.traceparent).toBe('<redacted>');
    expect(headers['content-type']).toBe('application/connect+proto');
  });

  it('produces byte-identical NDJSON for the same logical run with different UUIDs/timestamps', () => {
    const runA = syntheticCapture(UUID_A, UUID_B, UUID_C);
    const runB = syntheticCapture(
      '00000000-1111-4222-8333-444444444444',
      '55555555-6666-4777-8888-999999999999',
      'abcdefab-1234-4abc-8def-0123456789ab',
    );
    const outA = normalizeCapture(runA);
    const outB = normalizeCapture(runB);
    expect(outA.errorCount).toBe(0);
    expect(outB.errorCount).toBe(0);
    expect(outA.output).toBe(outB.output);
  });

  it('is idempotent: normalizing the same input twice yields byte-identical output', () => {
    const input = syntheticCapture(UUID_A, UUID_B, UUID_C);
    expect(normalizeCapture(input).output).toBe(normalizeCapture(input).output);
  });

  it('decodes gzip-compressed frames', () => {
    const payload = runRequestFrame(UUID_A, UUID_B);
    const frame = encodeConnectFrame(payload, { compressed: true });
    expect(frame[0]).toBe(CONNECT_FLAG_COMPRESSED);
    const record = rawRecord(payload, {
      flags: CONNECT_FLAG_COMPRESSED,
      payload_b64: frame.subarray(5).toString('base64'),
    });
    const result = normalizeCapture(rawLine(record));
    expect(result.errorCount).toBe(0);
    const decoded = result.records[0]?.decoded_fields as {
      message: { case: string };
    };
    expect(decoded.message.case).toBe('runRequest');
  });

  it('emits typed error records for truncated and gzip-corrupt frames and keeps processing', () => {
    const good = runRequestFrame(UUID_A, UUID_B);
    const truncated = good.subarray(0, Math.max(1, good.length - 2));
    const gzipCorrupt = gzipSync(runRequestFrame(UUID_A, UUID_B)).subarray(0, 5);
    const input = [
      rawLine(rawRecord(Buffer.from(truncated), { frame_index: 0 })),
      rawLine(
        rawRecord(Buffer.alloc(0), {
          frame_index: 1,
          flags: CONNECT_FLAG_COMPRESSED,
          payload_b64: Buffer.from(gzipCorrupt).toString('base64'),
        }),
      ),
      rawLine(rawRecord(good, { frame_index: 2 })),
    ].join('\n');
    const result = normalizeCapture(input);
    expect(result.errorCount).toBe(2);
    expect(result.records).toHaveLength(3);
    expect(result.records[0]?.error?.kind).toBe('truncated_payload');
    expect(result.records[0]?.decoded_fields).toBeNull();
    expect(result.records[1]?.error?.kind).toBe('gzip_decode');
    expect(result.records[2]?.error).toBeUndefined();
    const ok = result.records[2]?.decoded_fields as { message: { case: string } };
    expect(ok.message.case).toBe('runRequest');
  });

  it('flags structurally invalid raw lines as malformed_record errors', () => {
    const result = normalizeCapture('{"lane":"native"}');
    expect(result.errorCount).toBe(1);
    expect(result.records[0]?.error?.kind).toBe('malformed_record');
  });

  it('ignores blank lines', () => {
    const input = `${syntheticCapture(UUID_A, UUID_B, UUID_C)}\n\n`;
    const result = normalizeCapture(input);
    expect(result.records).toHaveLength(3);
    expect(result.errorCount).toBe(0);
  });

  it('keeps gunzip integrity: a compressed round-trip decodes equal to uncompressed', () => {
    const payload = execFrame(UUID_A, 5);
    const compressed = encodeConnectFrame(payload, { compressed: true });
    const round = gunzipSync(compressed.subarray(5));
    expect(round.equals(payload)).toBe(true);
  });
});
