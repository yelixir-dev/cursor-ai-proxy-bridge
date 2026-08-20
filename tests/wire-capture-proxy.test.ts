import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeTree } from '../scripts/wire-capture/decode.mjs';
import { generateCerts } from '../scripts/wire-capture/gen-certs.mjs';
import {
  type CaptureProxy,
  type ParsedFrame,
  createCaptureProxy,
  parseFrames,
  redactShape,
} from '../scripts/wire-capture/proxy.mjs';

function tmpDir(label: string): string {
  const base = process.env.TMPDIR ?? os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, `wire-capture-${label}-`));
}

function connectFrame(payload: Buffer, flags = 0): Buffer {
  const head = Buffer.alloc(5);
  head.writeUInt8(flags, 0);
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  const deadline = AbortSignal.timeout(10_000);
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      deadline.addEventListener(
        'abort',
        () => reject(new Error(`${label} exceeded 10 second bound`)),
        { once: true },
      );
    }),
  ]);
}

interface FakeUpstream {
  server: http2.Http2SecureServer;
  port: number;
  close: () => Promise<void>;
}

async function startFakeUpstream(certs: {
  key: Buffer;
  cert: Buffer;
  respondFrame: Buffer;
}): Promise<FakeUpstream> {
  const server = http2.createSecureServer({ key: certs.key, cert: certs.cert });
  server.on('stream', (stream: http2.ServerHttp2Stream, headers) => {
    if (headers[':path'] !== '/agent.v1.AgentService/Run') {
      stream.respond({ ':status': 404 });
      stream.end();
      return;
    }
    stream.respond({ ':status': 200, 'content-type': 'application/connect+proto' });
    stream.end(certs.respondFrame);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo | null;
  if (address === null) throw new Error('fake upstream has no bound address');
  return {
    server,
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

interface H2Result {
  status: number;
  body: Buffer;
}

async function h2Post(options: {
  port: number;
  ca: Buffer;
  path: string;
  body: Buffer;
  headers?: Record<string, string>;
}): Promise<H2Result> {
  const client = http2.connect(`https://127.0.0.1:${options.port}`, { ca: options.ca });
  try {
    return await bounded(
      new Promise<H2Result>((resolve, reject) => {
        const req = client.request({
          ':method': 'POST',
          ':path': options.path,
          'content-type': 'application/connect+proto',
          ...options.headers,
        });
        const chunks: Buffer[] = [];
        let status = 0;
        req.on('response', (headers) => {
          const raw = headers[':status'];
          status = typeof raw === 'number' ? raw : 0;
        });
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => resolve({ status, body: Buffer.concat(chunks) }));
        req.on('error', reject);
        req.end(options.body);
      }),
      'h2 client request',
    );
  } finally {
    client.close();
  }
}

describe('wire-capture proxy', () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      if (cleanup) await cleanup();
    }
  });

  it('redacts every sensitive header name in shape form only', () => {
    const sensitive = [
      'authorization',
      'cookie',
      'x-cursor-checksum',
      'x-cursor-privacy-mode',
      'proxy-authorization',
      'x-apis-key',
      'x-client-key',
    ];
    for (const name of sensitive) {
      const redacted = redactShape(name, 'Bearer abcdefghijklmnop');
      expect(redacted).toMatch(/^<REDACTED: /);
      expect(redacted).not.toContain('abcdefghijklmnop');
    }
    expect(redactShape('Authorization', 'Bearer eyJhbGciOi.payload.sig')).toContain(
      'Bearer <redacted',
    );
    expect(redactShape('x-apis-key', 'deadbeefcafe')).toContain('[hex]');
    expect(redactShape('x-cursor-session-id', 'visible-value')).toBe('visible-value');
  });

  it('parseFrames splits buffers, reports gzip corruption without throwing, and handles truncation', () => {
    const payload = Buffer.from('hello-connect-frame');
    const frame = connectFrame(payload);
    const splitAt = 7;
    const state: { buf: Buffer | null } = { buf: null };
    const frames: ParsedFrame[] = [];
    parseFrames(state, frame.subarray(0, splitAt), (f) => frames.push(f));
    expect(frames).toHaveLength(0);
    parseFrames(state, frame.subarray(splitAt), (f) => frames.push(f));
    expect(frames).toHaveLength(1);
    const first = frames[0];
    if (!first) throw new Error('expected one parsed frame');
    expect(first.flags).toBe(0);
    expect(first.payload.equals(payload)).toBe(true);
    expect(first.gunzipped).toBe(false);
    expect(first.error).toBeUndefined();

    const corrupt = connectFrame(Buffer.from('not-a-gzip-stream'), 0x01);
    const corruptFrames: ParsedFrame[] = [];
    parseFrames({ buf: null }, corrupt, (f) => corruptFrames.push(f));
    expect(corruptFrames).toHaveLength(1);
    const bad = corruptFrames[0];
    if (!bad) throw new Error('expected corrupt frame record');
    expect(bad.error).toBeInstanceOf(Error);
    expect(bad.gunzipped).toBe(false);
    expect(bad.payload.equals(Buffer.from('not-a-gzip-stream'))).toBe(true);

    const real = connectFrame(zlib.gzipSync(payload), 0x01);
    const gzFrames: ParsedFrame[] = [];
    parseFrames({ buf: null }, real, (f) => gzFrames.push(f));
    const gz = gzFrames[0];
    if (!gz) throw new Error('expected gunzipped frame');
    expect(gz.gunzipped).toBe(true);
    expect(gz.payload.equals(payload)).toBe(true);
  });

  it('decodeTree renders nested protobuf fields with string inference', () => {
    // field 1 varint 42, field 2 length-delimited string "hi"
    const buf = Buffer.from([0x08, 0x2a, 0x12, 0x02, 0x68, 0x69]);
    const lines = decodeTree(buf);
    expect(lines.join('\n')).toContain('f1: varint 42');
    expect(lines.join('\n')).toContain('f2: str(2) "hi"');
  });

  it('generateCerts produces a CA and leaf cert chain into the out dir', () => {
    const out = tmpDir('certs');
    cleanups.push(() => fs.rmSync(out, { recursive: true, force: true }));
    generateCerts({ out });
    for (const name of ['ca.crt', 'ca.key', 'leaf.crt', 'leaf.key']) {
      expect(fs.existsSync(path.join(out, name)), name).toBe(true);
    }
    const verify = execFileSync(
      'openssl',
      ['verify', '-CAfile', path.join(out, 'ca.crt'), path.join(out, 'leaf.crt')],
      { encoding: 'utf8' },
    );
    expect(verify).toContain('OK');
    const text = execFileSync(
      'openssl',
      ['x509', '-in', path.join(out, 'leaf.crt'), '-text', '-noout'],
      {
        encoding: 'utf8',
      },
    );
    expect(text).toContain('IP Address:127.0.0.1');
  });

  it('proxies an H2 POST through TLS MITM and captures byte-identical frames', async () => {
    const dir = tmpDir('e2e');
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const certDir = path.join(dir, 'certs');
    const captureDir = path.join(dir, 'captures');
    generateCerts({ out: certDir });
    const leafKey = fs.readFileSync(path.join(certDir, 'leaf.key'));
    const leafCrt = fs.readFileSync(path.join(certDir, 'leaf.crt'));
    const ca = fs.readFileSync(path.join(certDir, 'ca.crt'));

    const resPayload = Buffer.from('server-frame-payload');
    const upstream = await startFakeUpstream({
      key: leafKey,
      cert: leafCrt,
      respondFrame: connectFrame(resPayload),
    });
    cleanups.push(() => upstream.close());

    const proxy: CaptureProxy = createCaptureProxy({
      port: 0,
      targetHost: `127.0.0.1:${upstream.port}`,
      cert: leafCrt,
      key: leafKey,
      targetCa: ca,
      captureDir,
      log: () => {},
    });
    const address = await proxy.listen();
    cleanups.push(() => proxy.close());

    const reqPayload = Buffer.from('client-frame-payload');
    const result = await h2Post({
      port: address.port,
      ca,
      path: '/agent.v1.AgentService/Run',
      body: connectFrame(reqPayload),
    });
    expect(result.status).toBe(200);
    expect(result.body.equals(connectFrame(resPayload))).toBe(true);

    const captureFiles = fs.readdirSync(captureDir);
    const reqCapture = captureFiles.find((f) => f.endsWith('-req-00.bin'));
    const resCapture = captureFiles.find((f) => f.endsWith('-res-00.bin'));
    expect(reqCapture, `req capture in ${captureFiles.join(',')}`).toBeDefined();
    expect(resCapture, `res capture in ${captureFiles.join(',')}`).toBeDefined();
    if (!reqCapture || !resCapture) throw new Error('missing capture files');
    expect(fs.readFileSync(path.join(captureDir, reqCapture)).equals(reqPayload)).toBe(true);
    expect(fs.readFileSync(path.join(captureDir, resCapture)).equals(resPayload)).toBe(true);
  });

  it('returns non-2xx to the client and survives when the upstream is down', async () => {
    const dir = tmpDir('down');
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const certDir = path.join(dir, 'certs');
    generateCerts({ out: certDir });
    const ca = fs.readFileSync(path.join(certDir, 'ca.crt'));
    const errors: string[] = [];
    const proxy = createCaptureProxy({
      port: 0,
      targetHost: '127.0.0.1:1',
      cert: fs.readFileSync(path.join(certDir, 'leaf.crt')),
      key: fs.readFileSync(path.join(certDir, 'leaf.key')),
      targetCa: ca,
      captureDir: path.join(dir, 'captures'),
      log: (line) => errors.push(line),
    });
    const address = await proxy.listen();
    cleanups.push(() => proxy.close());

    const result = await h2Post({
      port: address.port,
      ca,
      path: '/agent.v1.AgentService/Run',
      body: connectFrame(Buffer.from('x')),
    });
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(errors.join('\n')).toMatch(/upstream/i);
  });
});
