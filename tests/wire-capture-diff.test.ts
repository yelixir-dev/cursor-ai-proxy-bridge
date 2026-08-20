import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { encodeConnectFrame } from '../src/backend/cursor-api/connect-frame.js';
import { loadProtoDescriptors, ProtoCodec } from '../src/backend/cursor-api/protobuf.js';
import { normalizeCapture } from '../scripts/wire-capture/normalize.mjs';
import { diffCaptures, DiffInputError } from '../scripts/wire-capture/diff.mjs';

const codec = new ProtoCodec(loadProtoDescriptors());

const UUID_A = '11111111-2222-4333-8444-555555555555';
const UUID_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const UUID_C = '99999999-8888-4777-8666-555554444444';

type OneofCase =
  | 'runRequest'
  | 'execClientMessage'
  | 'kvClientMessage'
  | 'clientHeartbeat'
  | 'interactionUpdate'
  | 'execServerMessage'
  | 'kvServerMessage';

interface FrameSpec {
  dir: 'client' | 'server';
  messageCase: OneofCase;
  value: Record<string, unknown>;
}

interface RawRecord {
  lane: string;
  conn: number;
  stream: number;
  dir: 'client' | 'server';
  frame_index: number;
  flags: number;
  payload_b64: string;
  message_type: string;
}

function rawRecord(spec: FrameSpec, frameIndex: number): string {
  const messageType =
    spec.dir === 'client' ? 'agent.v1.AgentClientMessage' : 'agent.v1.AgentServerMessage';
  const payload = codec.encode(messageType, {
    message: { case: spec.messageCase, value: spec.value },
  });
  const frame = encodeConnectFrame(payload);
  const record: RawRecord = {
    lane: 'native',
    conn: 1,
    stream: 3,
    dir: spec.dir,
    frame_index: frameIndex,
    flags: frame[0] ?? 0,
    payload_b64: frame.subarray(5).toString('base64'),
    message_type: messageType,
  };
  return JSON.stringify(record);
}

function rawCapture(specs: FrameSpec[]): string {
  return specs.map((spec, index) => rawRecord(spec, index)).join('\n');
}

function normalized(specs: FrameSpec[]): string {
  const result = normalizeCapture(rawCapture(specs));
  expect(result.errorCount).toBe(0);
  return result.output;
}

function baseSequence(runId: string, execId: string): FrameSpec[] {
  return [
    {
      dir: 'client',
      messageCase: 'runRequest',
      value: { conversationId: UUID_A, runId },
    },
    { dir: 'server', messageCase: 'interactionUpdate', value: { runId } },
    { dir: 'server', messageCase: 'execServerMessage', value: { id: 7, execId } },
    {
      dir: 'client',
      messageCase: 'execClientMessage',
      value: { id: 7, execId, localExecutionTimeMs: 1724000000123 },
    },
    { dir: 'client', messageCase: 'kvClientMessage', value: { id: 9, key: 'alpha' } },
    { dir: 'client', messageCase: 'clientHeartbeat', value: {} },
  ];
}

const DIFF_CLI = join(__dirname, '..', 'scripts', 'wire-capture', 'diff.mjs');

const tempDirs: string[] = [];

function tempCaptureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wire-diff-'));
  tempDirs.push(dir);
  return dir;
}

function runCli(
  aPath: string,
  bPath: string,
  extraArgs: string[] = [],
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [DIFF_CLI, aPath, bPath, ...extraArgs], {
    encoding: 'utf8',
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('wire-capture differ', () => {
  it('reports identical for two captures of the same logical run', () => {
    const a = normalized(baseSequence(UUID_B, UUID_C));
    const b = normalized(baseSequence(UUID_B, UUID_C));
    const report = diffCaptures(a, b);
    expect(report.identical).toBe(true);
    expect(report.deltas).toEqual([]);
    expect(report.summary.matched).toBe(6);
  });

  it('reports identical when captures differ only in normalized-away values', () => {
    const a = normalized(baseSequence(UUID_B, UUID_C));
    const b = normalized(
      baseSequence('00000000-1111-4222-8333-444444444444', 'abcdefab-1234-4abc-8def-0123456789ab'),
    );
    const report = diffCaptures(a, b);
    expect(report.identical).toBe(true);
    expect(report.deltas).toEqual([]);
  });

  it('flags an extra heartbeat frame in capture B', () => {
    const a = normalized(baseSequence(UUID_B, UUID_C));
    const bSpecs = baseSequence(UUID_B, UUID_C);
    bSpecs.push({ dir: 'client', messageCase: 'clientHeartbeat', value: {} });
    const report = diffCaptures(a, normalized(bSpecs));
    expect(report.identical).toBe(false);
    expect(report.deltas).toHaveLength(1);
    const delta = report.deltas[0];
    expect(delta?.type).toBe('extra_frame');
    expect(delta?.kind).toBe('client:client_heartbeat');
    expect(delta?.capture).toBe('b');
    expect(delta?.position).toBe(6);
  });

  it('flags a missing exec response frame with kind and position', () => {
    const aSpecs = baseSequence(UUID_B, UUID_C);
    const bSpecs = aSpecs.filter(
      (spec) => !(spec.dir === 'client' && spec.messageCase === 'execClientMessage'),
    );
    const report = diffCaptures(normalized(aSpecs), normalized(bSpecs));
    expect(report.identical).toBe(false);
    expect(report.deltas).toHaveLength(1);
    const delta = report.deltas[0];
    expect(delta?.type).toBe('missing_frame');
    expect(delta?.kind).toBe('client:exec_client_message');
    expect(delta?.capture).toBe('a');
    expect(delta?.position).toBe(3);
  });

  it('flags reordered kv messages as an ordering delta', () => {
    const aSpecs: FrameSpec[] = [
      { dir: 'client', messageCase: 'kvClientMessage', value: { id: 1 } },
      { dir: 'client', messageCase: 'kvClientMessage', value: { id: 2 } },
    ];
    const bSpecs: FrameSpec[] = [aSpecs[1] as FrameSpec, aSpecs[0] as FrameSpec];
    const report = diffCaptures(normalized(aSpecs), normalized(bSpecs));
    expect(report.identical).toBe(false);
    const ordering = report.deltas.filter((delta) => delta.type === 'ordering');
    expect(ordering.length).toBeGreaterThan(0);
    expect(ordering[0]?.kind).toBe('client:kv_client_message');
    const fieldDiffs = report.deltas.filter((delta) => delta.type === 'field_presence');
    expect(fieldDiffs.length).toBeGreaterThan(0);
  });

  it('reports field-presence diffs for paired frames with different structure', () => {
    const aSpecs: FrameSpec[] = [
      { dir: 'server', messageCase: 'execServerMessage', value: { id: 7, execId: UUID_C } },
    ];
    const bSpecs: FrameSpec[] = [
      {
        dir: 'server',
        messageCase: 'execServerMessage',
        value: { id: 7, execId: UUID_C, acceptHookAdditionalContexts: true },
      },
    ];
    const report = diffCaptures(normalized(aSpecs), normalized(bSpecs));
    expect(report.identical).toBe(false);
    const delta = report.deltas.find((entry) => entry.type === 'field_presence');
    expect(delta?.kind).toBe('server:exec_server_message');
    expect(delta?.only_in_b).toContain('message.value.acceptHookAdditionalContexts');
    expect(delta?.only_in_a).toEqual([]);
  });

  it('throws a typed DiffInputError on empty input without crashing', () => {
    expect(() => diffCaptures('', normalized(baseSequence(UUID_B, UUID_C)))).toThrow(
      DiffInputError,
    );
    expect(() => diffCaptures('', 'x')).toThrow(/empty/);
  });

  it('throws a typed DiffInputError on truncated NDJSON lines', () => {
    const good = normalized(baseSequence(UUID_B, UUID_C));
    const truncated = `${good}{"schema_version":1,"lane":"nat`;
    expect(() => diffCaptures(truncated, good)).toThrow(DiffInputError);
  });

  it('computes lifecycle timing deltas when lifecycle captures are provided', () => {
    const lifecycleA = [
      JSON.stringify({ ts: 1, mono_ms: 100, conn: 1, stream: 3, event: 'open' }),
      JSON.stringify({ ts: 1, mono_ms: 150, conn: 1, stream: 3, event: 'rst_stream' }),
    ].join('\n');
    const lifecycleB = [
      JSON.stringify({ ts: 2, mono_ms: 400, conn: 1, stream: 3, event: 'open' }),
      JSON.stringify({ ts: 2, mono_ms: 900, conn: 1, stream: 3, event: 'rst_stream' }),
    ].join('\n');
    const frames = normalized(baseSequence(UUID_B, UUID_C));
    const report = diffCaptures(frames, frames, { lifecycleA, lifecycleB });
    expect(report.identical).toBe(true);
    expect(report.lifecycle).toBeDefined();
    const open = report.lifecycle?.events.find((event) => event.event === 'open');
    expect(open?.delta_ms).toBe(300);
    const rst = report.lifecycle?.events.find((event) => event.event === 'rst_stream');
    expect(rst?.delta_ms).toBe(750);
  });

  it('flags lifecycle events present in only one capture', () => {
    const lifecycleA = JSON.stringify({ ts: 1, mono_ms: 100, conn: 1, stream: 3, event: 'open' });
    const lifecycleB = [
      JSON.stringify({ ts: 2, mono_ms: 400, conn: 1, stream: 3, event: 'open' }),
      JSON.stringify({ ts: 2, mono_ms: 500, conn: 1, stream: 3, event: 'goaway' }),
    ].join('\n');
    const frames = normalized(baseSequence(UUID_B, UUID_C));
    const report = diffCaptures(frames, frames, { lifecycleA, lifecycleB });
    expect(report.identical).toBe(false);
    const extra = report.deltas.find((delta) => delta.type === 'extra_lifecycle_event');
    expect(extra?.kind).toBe('goaway');
  });

  it('flags error records present in either capture', () => {
    const good = normalized(baseSequence(UUID_B, UUID_C));
    const withError = `${good}{"schema_version":1,"lane":"native","conn":1,"stream":3,"dir":"client","frame_index":6,"flags":0,"message_type":"agent.v1.AgentClientMessage","headers":null,"payload_sha256":null,"decoded_fields":null,"error":{"kind":"decode_error","message":"boom"}}\n`;
    const report = diffCaptures(withError, good);
    expect(report.identical).toBe(false);
    expect(report.deltas.some((delta) => delta.type === 'error_record')).toBe(true);
  });
});

describe('wire-capture differ CLI', () => {
  it('exits 0 with an empty delta list on identical captures', () => {
    const dir = tempCaptureDir();
    const a = join(dir, 'a.ndjson');
    const b = join(dir, 'b.ndjson');
    writeFileSync(a, normalized(baseSequence(UUID_B, UUID_C)));
    writeFileSync(b, normalized(baseSequence(UUID_B, UUID_C)));
    const out = join(dir, 'report.json');
    const result = runCli(a, b, ['--out', out]);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as { identical: boolean; deltas: unknown[] };
    expect(report.identical).toBe(true);
    expect(report.deltas).toEqual([]);
  });

  it('exits 1 with a named delta list on divergent captures', () => {
    const dir = tempCaptureDir();
    const a = join(dir, 'a.ndjson');
    const b = join(dir, 'b.ndjson');
    const aSpecs = baseSequence(UUID_B, UUID_C);
    writeFileSync(a, normalized(aSpecs));
    writeFileSync(b, normalized(aSpecs.filter((spec) => spec.messageCase !== 'execClientMessage')));
    const result = runCli(a, b);
    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout) as {
      identical: boolean;
      deltas: Array<{ type: string; kind: string }>;
    };
    expect(report.identical).toBe(false);
    expect(
      report.deltas.some(
        (delta) => delta.type === 'missing_frame' && delta.kind === 'client:exec_client_message',
      ),
    ).toBe(true);
    expect(result.stderr).toMatch(/missing_frame/);
  });

  it('exits 2 on malformed input files', () => {
    const dir = tempCaptureDir();
    const a = join(dir, 'a.ndjson');
    const b = join(dir, 'b.ndjson');
    writeFileSync(a, '');
    writeFileSync(b, normalized(baseSequence(UUID_B, UUID_C)));
    const result = runCli(a, b);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/empty/);
  });

  it('exits 2 on missing arguments', () => {
    const result = spawnSync(process.execPath, [DIFF_CLI], { encoding: 'utf8' });
    expect(result.status).toBe(2);
  });
});
