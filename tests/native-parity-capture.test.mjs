/* global Buffer, AbortSignal */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http2 from 'node:http2';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';
import { createCaptureProxy, parseFrames } from '../scripts/wire-capture/proxy.mjs';
import { generateCerts } from '../scripts/wire-capture/gen-certs.mjs';
import { analyzeFrames } from '../scripts/native-parity-live.mjs';
import { ProtoCodec, loadProtoDescriptors } from '../src/backend/cursor-api/protobuf.ts';

function envelope(payload, flags = 0) {
  const b = Buffer.alloc(5);
  b[0] = flags;
  b.writeUInt32BE(payload.length, 1);
  return Buffer.concat([b, payload]);
}

describe('optional exact native parity captures', () => {
  it('keeps the cancelled profile while counting the separate recovery Run', () => {
    const codec = new ProtoCodec(loadProtoDescriptors());
    const rows = [1, 3].map((stream, sequence) => ({
      event: 'frame',
      conn: 'one',
      stream,
      dir: 'client',
      flags: 0,
      sequence,
      payload_b64: Buffer.from(
        codec.encode('agent.v1.AgentClientMessage', {
          message: { case: 'runRequest', value: { conversationId: 'conversation-' + stream } },
        }),
      ).toString('base64'),
    }));
    const result = analyzeFrames(rows, codec, 'cancel');
    expect(result.decode_errors).toBe(0);
    expect(result.kinds['client:runRequest']).toBe(2);
    expect(result.profile.run.conversationId).toBe('conversation-1');
    expect(analyzeFrames(rows, codec, 'chat').decode_errors).toBe(1);
  });
  it('requires every exec reply to close its own stream after the result', () => {
    const codec = new ProtoCodec(loadProtoDescriptors());
    const messages = [
      {
        case: 'execClientMessage',
        value: {
          id: 7,
          message: { case: 'mcpResult', value: { result: { case: 'success', value: {} } } },
        },
      },
      {
        case: 'execClientControlMessage',
        value: { message: { case: 'streamClose', value: { id: 7 } } },
      },
    ];
    const rows = messages.map((message, sequence) => ({
      event: 'frame',
      conn: 'one',
      stream: 1,
      dir: 'client',
      flags: 0,
      sequence,
      payload_b64: Buffer.from(codec.encode('agent.v1.AgentClientMessage', { message })).toString(
        'base64',
      ),
    }));
    expect(analyzeFrames(rows.slice(0, 1), codec, 'chat').exec_failures).toEqual([
      'exec_close_missing',
    ]);
    expect(analyzeFrames(rows, codec, 'chat').exec_failures).toEqual([]);
    expect(
      analyzeFrames(
        rows.map((r, index) => ({ ...r, sequence: 1 - index })),
        codec,
        'chat',
      ).exec_failures,
    ).toEqual(['exec_close_before_result']);
    expect(
      analyzeFrames([rows[0], { ...rows[1], stream: 2 }], codec, 'chat').exec_failures,
    ).toEqual(['exec_close_missing']);
  });
  it('retains complete client Run and context values for differential judgment', () => {
    const codec = new ProtoCodec(loadProtoDescriptors());
    const run = {
      conversationId: 'conversation',
      requestedModel: {
        modelId: 'composer-2.5',
        parameters: [{ id: 'fast', value: 'false' }],
      },
    };
    const context = {
      repositoryInfo: [
        {
          repoName: 'repository',
          repoOwner: 'account',
          pathEncryptionKey: 'key',
        },
      ],
      agentSkills: [{ fullPath: '/skill/SKILL.md', description: 'skill data' }],
    };
    const rows = [
      { case: 'runRequest', value: run },
      {
        case: 'execClientMessage',
        value: {
          message: {
            case: 'requestContextResult',
            value: {
              result: { case: 'success', value: { requestContext: context } },
            },
          },
        },
      },
    ].map((message, sequence) => ({
      event: 'frame',
      conn: 'one',
      stream: 1,
      dir: 'client',
      flags: 0,
      sequence,
      payload_b64: Buffer.from(codec.encode('agent.v1.AgentClientMessage', { message })).toString(
        'base64',
      ),
    }));
    expect(analyzeFrames(rows, codec, 'chat').profile).toEqual({
      run,
      context,
    });
    const changed = globalThis.structuredClone(context);
    changed.repositoryInfo[0].pathEncryptionKey = 'other-account-key';
    rows[1].payload_b64 = Buffer.from(
      codec.encode('agent.v1.AgentClientMessage', {
        message: {
          case: 'execClientMessage',
          value: {
            message: {
              case: 'requestContextResult',
              value: {
                result: { case: 'success', value: { requestContext: changed } },
              },
            },
          },
        },
      }),
    ).toString('base64');
    expect(
      analyzeFrames(rows, codec, 'chat').profile.context.repositoryInfo[0].pathEncryptionKey,
    ).toBe('other-account-key');
  });

  it('recognizes the actual CLI meta-tool declaration without inventing a full schema', () => {
    const rows = [
      {
        event: 'frame',
        conn: 1,
        stream: 1,
        sequence: 1,
        dir: 'client',
        flags: 0,
        payload_b64: Buffer.from(
          '122752250a230a2192021e0801121a0a04776972651204776972652a0c0a0a6563686f5f76616c7565',
          'hex',
        ).toString('base64'),
      },
    ];
    const result = analyzeFrames(rows, new ProtoCodec(loadProtoDescriptors()), 'parallel');
    expect(result.declared_tools).toEqual(['echo_value']);
    expect(result.mcp_requests).toBe(0);
    expect(result.failures).toContain('external_mcp_wire_incomplete');
  });

  it('requires tool declarations and successful correlated MCP answers on actual protobuf frames', () => {
    const codec = new ProtoCodec(loadProtoDescriptors());
    const rows = [];
    const add = (dir, value) =>
      rows.push({
        event: 'frame',
        conn: 'conn-1',
        stream: 1,
        sequence: rows.length,
        dir,
        flags: 0,
        payload_b64: Buffer.from(
          codec.encode(
            dir === 'client' ? 'agent.v1.AgentClientMessage' : 'agent.v1.AgentServerMessage',
            value,
          ),
        ).toString('base64'),
      });
    add('client', {
      message: {
        case: 'runRequest',
        value: {
          mcpTools: {
            mcpTools: [
              {
                name: 'wire_echo_value',
                toolName: 'echo_value',
                inputSchemaJson: '{"type":"object"}',
              },
            ],
          },
        },
      },
    });
    for (const id of [1, 2])
      add('server', {
        message: {
          case: 'execServerMessage',
          value: {
            id,
            message: { case: 'mcpArgs', value: { name: 'wire_echo_value' } },
          },
        },
      });
    for (const id of [1, 2])
      add('client', {
        message: {
          case: 'execClientMessage',
          value: {
            id,
            message: {
              case: 'mcpResult',
              value: { result: { case: 'success', value: {} } },
            },
          },
        },
      });
    rows.push({
      event: 'frame',
      conn: 'conn-1',
      stream: 1,
      sequence: rows.length,
      dir: 'server',
      flags: 2,
      payload_b64: Buffer.from('{}').toString('base64'),
    });
    const good = analyzeFrames(rows, codec, 'parallel');
    expect(good.failures).toEqual([]);
    expect(good.parallel_overlap_observed).toBe(true);
    expect(good.declared_tools).toEqual(['echo_value']);
    expect(
      analyzeFrames(
        rows.filter((_, index) => index !== 3),
        codec,
        'parallel',
      ).mcp_unanswered,
    ).toBe(1);
    expect(analyzeFrames(rows.slice(1), codec, 'parallel').failures).toContain(
      'external_mcp_wire_incomplete',
    );
  });
  it('exposes the exact compressed envelope before decoding, including split frames', () => {
    const wire = envelope(gzipSync(Buffer.from('payload')), 1);
    const order = [];
    const raw = [];
    const state = {};
    const onRaw = (frame) => {
      order.push('raw');
      raw.push(Buffer.from(frame));
    };
    parseFrames(state, wire.subarray(0, 3), () => order.push('decoded'), onRaw);
    parseFrames(state, wire.subarray(3), () => order.push('decoded'), onRaw);
    expect(raw).toEqual([wire]);
    expect(order).toEqual(['raw', 'decoded']);
  });
  it('records ordered exact frames with actual H2 connection and stream IDs beyond bin caps', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-parity-exact-'));
    generateCerts({ out: path.join(root, 'certs') });
    const key = fs.readFileSync(path.join(root, 'certs/leaf.key'));
    const cert = fs.readFileSync(path.join(root, 'certs/leaf.crt'));
    const ca = fs.readFileSync(path.join(root, 'certs/ca.crt'));
    const sessions = new Set();
    const upstream = http2.createSecureServer({ key, cert });
    upstream.on('session', (session) => {
      sessions.add(session);
      session.once('close', () => sessions.delete(session));
    });
    const response = envelope(gzipSync(Buffer.from('response')), 1);
    upstream.on('stream', (stream) => {
      stream.on('data', () => {});
      stream.respond({ 'content-type': 'application/connect+proto' });
      stream.end(response);
    });
    const listening = once(upstream, 'listening');
    upstream.listen(0, '127.0.0.1');
    await listening;
    const events = [];
    const proxy = createCaptureProxy({
      port: 0,
      targetHost: `127.0.0.1:${upstream.address().port}`,
      targetCa: ca,
      key,
      cert,
      captureDir: root,
      captureExact: true,
      onLifecycle: (event) => events.push(event),
      maxReqFrameBins: 0,
      maxResFrameBins: 0,
      log: () => {},
    });
    let client;
    try {
      const address = await proxy.listen();
      client = http2.connect(`https://127.0.0.1:${address.port}`, { ca });
      for (const expectedId of [1, 3]) {
        const req = client.request({
          ':method': 'POST',
          ':path': '/agent.v1.AgentService/Run',
          'content-type': 'application/connect+proto',
        });
        req.on('data', () => {});
        const ended = once(req, 'end', { signal: AbortSignal.timeout(5000) });
        req.end(envelope(Buffer.from(`request-${expectedId}`)));
        await ended;
      }
      const rows = fs
        .readFileSync(path.join(root, 'exact-wire.ndjson'), 'utf8')
        .trim()
        .split('\n')
        .map(JSON.parse);
      const frames = rows.filter((r) => r.event === 'frame');
      expect(frames.map((r) => [r.conn, r.stream, r.dir])).toEqual([
        ['conn-1', 1, 'client'],
        ['conn-1', 1, 'server'],
        ['conn-1', 3, 'client'],
        ['conn-1', 3, 'server'],
      ]);
      expect(
        frames.filter((r) => r.dir === 'server').map((r) => Buffer.from(r.frame_b64, 'base64')),
      ).toEqual([response, response]);
      expect(frames.filter((r) => r.dir === 'server').map((r) => r.flags)).toEqual([1, 1]);
      expect(rows.map((r) => r.sequence)).toEqual(rows.map((_, i) => i));
      expect(events.filter((e) => e.event === 'open').map((e) => e.stream)).toEqual([1, 3]);
      expect(fs.readdirSync(root).filter((f) => /^H2-/.test(f))).toEqual([]);
    } finally {
      client?.destroy();
      await proxy.close();
      for (const session of sessions) session.destroy();
      await new Promise((resolve) => upstream.close(resolve));
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
