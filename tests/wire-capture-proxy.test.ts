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
  client.on('error', () => undefined);
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
    if (!client.destroyed) client.destroy();
  }
}

interface LifecycleLine {
  ts: string;
  mono_ms: number;
  conn: string;
  stream: number | null;
  event: string;
  detail: Record<string, unknown>;
}

function readLifecycle(captureDir: string): LifecycleLine[] {
  const raw = fs.readFileSync(path.join(captureDir, 'lifecycle.ndjson'), 'utf8');
  return raw
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as LifecycleLine);
}

function waitForLifecycleEvent(
  captureDir: string,
  event: string,
  signal?: AbortSignal,
): Promise<LifecycleLine> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const watchers: fs.FSWatcher[] = [];
    const done = (error?: Error, value?: LifecycleLine) => {
      if (settled) return;
      settled = true;
      for (const watcher of watchers) watcher.close();
      signal?.removeEventListener('abort', onAbort);
      if (error) {
        reject(error);
        return;
      }
      if (!value) {
        reject(new Error(`lifecycle event ${event} settled without a line`));
        return;
      }
      resolve(value);
    };
    const onAbort = () => done(new Error(`lifecycle event ${event} aborted`));
    const check = (): LifecycleLine | undefined => {
      const file = path.join(captureDir, 'lifecycle.ndjson');
      if (!fs.existsSync(file)) return undefined;
      return readLifecycle(captureDir).find((l) => l.event === event);
    };
    const existing = check();
    if (existing) {
      done(undefined, existing);
      return;
    }
    const watcher = fs.watch(captureDir, () => {
      const found = check();
      if (found) done(undefined, found);
    });
    watchers.push(watcher);
    watcher.on('error', (error) => done(error));
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

describe('wire-capture proxy', () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      if (cleanup) await cleanup();
    }
  }, 8_000);

  it('redacts every sensitive header name in shape form only', () => {
    const sensitive = [
      'authorization',
      'cookie',
      'x-cursor-checksum',
      'x-cursor-privacy-mode',
      'proxy-authorization',
      'x-apis-key',
      'x-blob-encryption-key',
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

  it('records ordered open/data/rst lifecycle lines when the client aborts mid-stream', async () => {
    const dir = tmpDir('abort');
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const certDir = path.join(dir, 'certs');
    const captureDir = path.join(dir, 'captures');
    generateCerts({ out: certDir });
    const leafKey = fs.readFileSync(path.join(certDir, 'leaf.key'));
    const leafCrt = fs.readFileSync(path.join(certDir, 'leaf.crt'));
    const ca = fs.readFileSync(path.join(certDir, 'ca.crt'));

    const resPayload = Buffer.from('res-frame-0');
    let resolveUpstreamClosed: (rstCode: number | undefined) => void = () => {};
    const upstreamClosed = new Promise<number | undefined>((resolve) => {
      resolveUpstreamClosed = resolve;
    });
    const upstreamServer = http2.createSecureServer({ key: leafKey, cert: leafCrt });
    upstreamServer.on('stream', (stream: http2.ServerHttp2Stream, headers) => {
      if (headers[':path'] !== '/agent.v1.AgentService/Run') {
        stream.respond({ ':status': 404 });
        stream.end();
        return;
      }
      stream.on('data', () => {});
      stream.respond({ ':status': 200, 'content-type': 'application/connect+proto' });
      stream.write(connectFrame(resPayload));
      // keep the stream open; the client is expected to abort
      stream.on('close', () => resolveUpstreamClosed(stream.rstCode));
    });
    await new Promise<void>((resolve) => upstreamServer.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve) => upstreamServer.close(() => resolve())));
    const upstreamAddress = upstreamServer.address() as AddressInfo | null;
    if (upstreamAddress === null) throw new Error('upstream has no bound address');

    const proxy = createCaptureProxy({
      port: 0,
      targetHost: `127.0.0.1:${upstreamAddress.port}`,
      cert: leafCrt,
      key: leafKey,
      targetCa: ca,
      captureDir,
      log: () => {},
    });
    const address = await proxy.listen();
    cleanups.push(() => proxy.close());

    const client = http2.connect(`https://127.0.0.1:${address.port}`, { ca });
    cleanups.push(() => client.destroy());
    const req = client.request({
      ':method': 'POST',
      ':path': '/agent.v1.AgentService/Run',
      'content-type': 'application/connect+proto',
    });
    const firstResData = new Promise<void>((resolve, reject) => {
      req.once('data', () => resolve());
      req.once('error', reject);
    });
    req.write(connectFrame(Buffer.from('req-frame-0')));
    await bounded(firstResData, 'first response data frame');
    const clientClosed = new Promise<void>((resolve) => req.once('close', () => resolve()));
    req.close(http2.constants.NGHTTP2_CANCEL);
    const upstreamRst = await bounded(upstreamClosed, 'upstream observes propagated RST_STREAM');
    expect(upstreamRst).toBe(http2.constants.NGHTTP2_CANCEL);
    await bounded(clientClosed, 'client stream close');

    const lines = readLifecycle(captureDir);
    const streamLines = lines.filter(
      (l) => l.stream !== null && ['open', 'data', 'rst', 'close'].includes(l.event),
    );
    const events = streamLines.map((l) => l.event);
    const openIdx = events.indexOf('open');
    const dataIdx = events.indexOf('data');
    const rstIdx = events.indexOf('rst');
    expect(openIdx, `open in ${events.join(',')}`).toBeGreaterThanOrEqual(0);
    expect(dataIdx, `data in ${events.join(',')}`).toBeGreaterThan(openIdx);
    expect(rstIdx, `rst in ${events.join(',')}`).toBeGreaterThan(dataIdx);
    const rstLine = streamLines[rstIdx];
    if (!rstLine) throw new Error('missing rst lifecycle line');
    expect(rstLine.detail.origin).toBe('downstream');
    expect(rstLine.detail.error_code).toBe(http2.constants.NGHTTP2_CANCEL);
    expect(rstLine.detail.error).toBe('CANCEL');
    const dataLine = streamLines[dataIdx];
    if (!dataLine) throw new Error('missing data lifecycle line');
    expect(dataLine.detail.dir).toBe('req');
    expect(dataLine.detail.first).toBe(true);
    const closeLine = streamLines.find((l) => l.event === 'close');
    if (!closeLine) throw new Error('missing close lifecycle line');
    expect(closeLine.detail.rst_code).toBe(http2.constants.NGHTTP2_CANCEL);
    // monotonic timestamps across the stream's lifecycle
    for (let i = 1; i < streamLines.length; i++) {
      const prev = streamLines[i - 1];
      const cur = streamLines[i];
      if (!prev || !cur) throw new Error('lifecycle line indexing failed');
      expect(cur.mono_ms >= prev.mono_ms).toBe(true);
    }
    for (const line of streamLines) {
      expect(typeof line.ts).toBe('string');
      expect(typeof line.mono_ms).toBe('number');
      expect(typeof line.conn).toBe('string');
    }
  });

  it('logs upstream GOAWAY mid-stream and survives to serve a second connection', async () => {
    const dir = tmpDir('goaway');
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const certDir = path.join(dir, 'certs');
    const captureDir = path.join(dir, 'captures');
    generateCerts({ out: certDir });
    const leafKey = fs.readFileSync(path.join(certDir, 'leaf.key'));
    const leafCrt = fs.readFileSync(path.join(certDir, 'leaf.crt'));
    const ca = fs.readFileSync(path.join(certDir, 'ca.crt'));

    const resPayload = Buffer.from('goaway-res-payload');
    let upstreamH2Session: http2.ServerHttp2Session | null = null;
    let streamCount = 0;
    const upstreamServer = http2.createSecureServer({ key: leafKey, cert: leafCrt });
    upstreamServer.on('session', (s: http2.ServerHttp2Session) => {
      upstreamH2Session = s;
    });
    upstreamServer.on('stream', (stream: http2.ServerHttp2Stream) => {
      streamCount += 1;
      const isFirst = streamCount === 1;
      stream.respond({ ':status': 200, 'content-type': 'application/connect+proto' });
      stream.end(connectFrame(resPayload));
      if (isFirst) {
        const s = upstreamH2Session;
        if (!s) throw new Error('upstream session not captured');
        // emit GOAWAY right after the first stream's data, mid-session
        setImmediate(() => s.goaway(http2.constants.NGHTTP2_NO_ERROR));
      }
    });
    await new Promise<void>((resolve) => upstreamServer.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve) => upstreamServer.close(() => resolve())));
    const upstreamAddress = upstreamServer.address() as AddressInfo | null;
    if (upstreamAddress === null) throw new Error('upstream has no bound address');

    const proxy = createCaptureProxy({
      port: 0,
      targetHost: `127.0.0.1:${upstreamAddress.port}`,
      cert: leafCrt,
      key: leafKey,
      targetCa: ca,
      captureDir,
      log: () => {},
    });
    const address = await proxy.listen();
    cleanups.push(() => proxy.close());

    const goawaySeen = waitForLifecycleEvent(captureDir, 'goaway', AbortSignal.timeout(10_000));
    const first = await h2Post({
      port: address.port,
      ca,
      path: '/agent.v1.AgentService/Run',
      body: connectFrame(Buffer.from('first-req')),
    });
    expect(first.status).toBe(200);
    expect(first.body.equals(connectFrame(resPayload))).toBe(true);

    const goawayLine = await bounded(goawaySeen, 'goaway lifecycle line');
    expect(goawayLine.detail.origin).toBe('upstream');
    expect(goawayLine.detail.error_code).toBe(http2.constants.NGHTTP2_NO_ERROR);

    // proxy must survive: a fresh client connection is served through a new upstream session
    const second = await h2Post({
      port: address.port,
      ca,
      path: '/agent.v1.AgentService/Run',
      body: connectFrame(Buffer.from('second-req')),
    });
    expect(second.status).toBe(200);
    expect(second.body.equals(connectFrame(resPayload))).toBe(true);
    expect(streamCount).toBe(2);
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

  it('close() settles while a client H2 session is still open', async () => {
    const dir = tmpDir('close-live');
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const certDir = path.join(dir, 'certs');
    generateCerts({ out: certDir });
    const leafKey = fs.readFileSync(path.join(certDir, 'leaf.key'));
    const leafCrt = fs.readFileSync(path.join(certDir, 'leaf.crt'));
    const ca = fs.readFileSync(path.join(certDir, 'ca.crt'));
    const upstream = await startFakeUpstream({
      key: leafKey,
      cert: leafCrt,
      respondFrame: connectFrame(Buffer.from('live-close')),
    });
    cleanups.push(() => upstream.close());
    const proxy = createCaptureProxy({
      port: 0,
      targetHost: `127.0.0.1:${upstream.port}`,
      cert: leafCrt,
      key: leafKey,
      targetCa: ca,
      captureDir: path.join(dir, 'captures'),
      log: () => {},
    });
    const address = await proxy.listen();
    const client = http2.connect(`https://127.0.0.1:${address.port}`, { ca });
    client.on('error', () => undefined);
    const ping = client.request({ ':method': 'POST', ':path': '/ping' });
    ping.on('error', () => undefined);
    ping.end();
    await bounded(proxy.close(), 'proxy close with live client');
    if (!client.closed && !client.destroyed) client.destroy();
  });
});
