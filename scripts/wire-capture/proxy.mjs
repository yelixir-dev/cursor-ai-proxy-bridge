#!/usr/bin/env node
/* global Buffer, URL, console, performance, process, setTimeout, clearTimeout */
// Local TLS MITM forward proxy for cursor-agent protocol capture.
// Ported from /tmp/cursor-mitm/proxy.mjs (proven 2026-08-17) with parametrized config.
// Usage: node proxy.mjs --port 8443 --target-host api2.cursor.sh --cert leaf.crt --key leaf.key --capture-dir captures [--target-ca ca.crt]
// Logs header NAMES always; sensitive header VALUES only in redacted shape form.
import fs from 'node:fs';
import http2 from 'node:http2';
import https from 'node:https';
import path from 'node:path';
import zlib from 'node:zlib';

const SENSITIVE = new Set([
  'authorization',
  'cookie',
  'x-cursor-checksum',
  'x-cursor-privacy-mode',
  'proxy-authorization',
  'x-apis-key',
  'x-blob-encryption-key',
  'x-client-key',
]);

// Caps how many Connect frames are retained as .bin files. Later frames are
// still parsed and lifecycle-logged (stream open/data/rst/close); only the
// raw payload dump is skipped. Override via --max-req-bins / --max-res-bins.
const MAX_REQ_FRAME_BINS = 12;
const MAX_RES_FRAME_BINS = 40;

function redactShape(name, value) {
  if (!SENSITIVE.has(name.toLowerCase())) return value;
  const v = String(value);
  const m = v.match(/^(Bearer|Basic)\s+(.*)$/);
  const body = m ? m[2] : v;
  let shape = `${body.length} chars`;
  if (m) shape = `${m[1]} <redacted, ${body.length} chars>`;
  if (body.split('.').length === 3) shape += ' [3-segment JWT]';
  if (body.startsWith('eyJ')) shape += ' [jwt-prefixed]';
  if (/^[0-9a-f]{8,}$/i.test(body) && body.length <= 80) shape += ' [hex]';
  return `<REDACTED: ${shape}>`;
}

// --- Connect envelope frame parser: [flags:1][len:4 BE][payload] ---
// onFrame({ flags, payload, gunzipped, error }) - error is set (not thrown) on
// gzip corruption so malformed input can never crash the capture loop.
function parseFrames(state, chunk, onFrame, onRawFrame) {
  state.buf = state.buf ? Buffer.concat([state.buf, chunk]) : chunk;
  for (;;) {
    if (state.buf.length < 5) return;
    const flags = state.buf[0];
    const len = state.buf.readUInt32BE(1);
    if (state.buf.length < 5 + len) return;
    onRawFrame?.(state.buf.subarray(0, 5 + len));
    let payload = state.buf.subarray(5, 5 + len);
    state.buf = state.buf.subarray(5 + len);
    let gunzipped = false;
    let error;
    if (flags & 0x01) {
      try {
        payload = zlib.gunzipSync(payload);
        gunzipped = true;
      } catch (e) {
        error = e instanceof Error ? e : new Error(String(e));
      }
    }
    onFrame({ flags, payload, gunzipped, error });
  }
}

function parseVarint(buf, pos) {
  let val = 0n,
    shift = 0n,
    p = pos;
  for (;;) {
    if (p >= buf.length) return null;
    const b = buf[p++];
    val |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) return { val: Number(val), pos: p };
    shift += 7n;
    if (shift > 63n) return null;
  }
}

// Top-level protobuf field numbers (2 levels deep), heuristic
function fieldPath(buf, depth = 1) {
  const out = [];
  let p = 0,
    guard = 0;
  while (p < buf.length && out.length < 6 && guard++ < 24) {
    const t = parseVarint(buf, p);
    if (!t) break;
    const fieldNo = t.val >>> 3,
      wt = t.val & 7;
    p = t.pos;
    if (fieldNo === 0) break;
    if (wt === 0) {
      const v = parseVarint(buf, p);
      if (!v) break;
      p = v.pos;
      out.push(`${fieldNo}`);
    } else if (wt === 1) {
      p += 8;
      out.push(`${fieldNo}`);
    } else if (wt === 2) {
      const l = parseVarint(buf, p);
      if (!l) break;
      p = l.pos;
      out.push(`${fieldNo}`);
      if (depth > 1 && l.val > 0 && l.val < 4096) {
        const sub = buf.subarray(p, p + l.val);
        const inner = fieldPath(sub, depth - 1);
        out[out.length - 1] = `${fieldNo}{${inner.join(',')}}`;
      }
      p += l.val;
    } else if (wt === 5) {
      p += 4;
      out.push(`${fieldNo}`);
    } else break;
  }
  return out;
}

const DROP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'host',
  'upgrade',
  'proxy-connection',
  'te',
  'trailer',
]);
function fwdHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h))
    if (k[0] !== ':' && !DROP.has(k.toLowerCase())) out[k] = v;
  return out;
}

function createCaptureProxy(options) {
  const { targetHost, captureDir } = options;
  const maxReqFrameBins = Number.isFinite(options.maxReqFrameBins)
    ? options.maxReqFrameBins
    : MAX_REQ_FRAME_BINS;
  const maxResFrameBins = Number.isFinite(options.maxResFrameBins)
    ? options.maxResFrameBins
    : MAX_RES_FRAME_BINS;
  const log = options.log ?? ((...a) => console.log(new Date().toISOString(), ...a));
  fs.mkdirSync(captureDir, { recursive: true });
  const upstreamTls = options.targetCa ? { ca: options.targetCa } : {};
  let reqSeq = 0;

  // --- H2 stream lifecycle NDJSON (P2 abort measurement instrument) ---
  const lifecyclePath = path.join(captureDir, 'lifecycle.ndjson');
  const monoStart = performance.now();
  function lifecycle(entry) {
    const line = {
      ts: new Date().toISOString(),
      mono_ms: Math.round((performance.now() - monoStart) * 1000) / 1000,
      conn: entry.conn,
      stream: entry.stream ?? null,
      event: entry.event,
      detail: entry.detail ?? {},
    };
    try {
      fs.appendFileSync(lifecyclePath, `${JSON.stringify(line)}\n`);
      options.onLifecycle?.(line);
    } catch (e) {
      // capture dir may already be gone during teardown; lifecycle is best-effort there
      if (!(e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT')) throw e;
    }
  }
  let connSeq = 0;
  let upstreamSeq = 0;
  const sessionConn = new WeakMap();
  const RST_ERROR_NAMES = new Set([
    'NGHTTP2_NO_ERROR',
    'NGHTTP2_PROTOCOL_ERROR',
    'NGHTTP2_INTERNAL_ERROR',
    'NGHTTP2_FLOW_CONTROL_ERROR',
    'NGHTTP2_SETTINGS_TIMEOUT',
    'NGHTTP2_STREAM_CLOSED',
    'NGHTTP2_FRAME_SIZE_ERROR',
    'NGHTTP2_REFUSED_STREAM',
    'NGHTTP2_CANCEL',
    'NGHTTP2_COMPRESSION_ERROR',
    'NGHTTP2_CONNECT_ERROR',
    'NGHTTP2_ENHANCE_YOUR_CALM',
    'NGHTTP2_INADEQUATE_SECURITY',
    'NGHTTP2_HTTP_1_1_REQUIRED',
  ]);
  function rstName(code) {
    const names = http2.constants;
    for (const k of Object.keys(names))
      if (RST_ERROR_NAMES.has(k) && names[k] === code) return k.slice('NGHTTP2_'.length);
    return `code_${code}`;
  }

  function capFile(tag, id, idx, dir) {
    return path.join(captureDir, `${tag}-${id}-${dir}-${String(idx).padStart(2, '0')}.bin`);
  }

  function logHeaders(tag, id, label, headers) {
    const entries = Object.entries(headers).filter(([k]) => k[0] !== ':');
    log(`${tag}#${id} ${label} headerNames=${entries.map(([k]) => k).join(',')}`);
    for (const [k, v] of entries) {
      if (SENSITIVE.has(k.toLowerCase())) log(`${tag}#${id} ${label} ${k}: ${redactShape(k, v)}`);
      else log(`${tag}#${id} ${label} ${k}: ${String(v).slice(0, 160)}`);
    }
  }

  let exactSequence = 0;
  function makeStreamLogger(tag, id, spath, ctype, conn = null, stream = null) {
    const exact = (entry) => {
      if (!options.captureExact) return;
      fs.appendFileSync(
        path.join(captureDir, 'exact-wire.ndjson'),
        `${JSON.stringify({
          schema_version: 1,
          sequence: exactSequence++,
          mono_ms: performance.now() - monoStart,
          conn,
          stream,
          request_id: id,
          path: spath,
          ...entry,
        })}\n`,
        { mode: 0o600 },
      );
    };
    const rawFrame = (dir, frame_index) => (frame) =>
      exact({
        event: 'frame',
        dir,
        frame_index,
        flags: frame[0],
        frame_b64: frame.toString('base64'),
        payload_b64: frame.subarray(5).toString('base64'),
      });
    const isStreaming = /connect\+proto/.test(ctype || '');
    const isProto = /proto/.test(ctype || '');
    const stReq = { buf: null },
      stRes = { buf: null };
    let reqN = 0,
      resN = 0;
    const summary = { req: [], res: [] };
    const want = /AgentService|StreamUnified|StreamPrompt/.test(spath);
    return {
      reqData(chunk) {
        exact({ event: 'data', dir: 'client', chunk_b64: chunk.toString('base64') });
        if (!isProto || chunk.length === 0) return;
        if (!isStreaming) {
          log(
            `${tag}#${id} UNARY-REQ chunk ${chunk.length}B first32=${chunk.subarray(0, 32).toString('hex')}`,
          );
          return;
        }
        parseFrames(
          stReq,
          chunk,
          ({ flags, payload, error }) => {
            const idx = reqN++;
            const fp = fieldPath(payload, 2).join(' ');
            if (error) log(`${tag}#${id} REQ frame[${idx}] gunzip fail ${error.message}`);
            log(
              `${tag}#${id} REQ frame[${idx}] flags=0x${flags.toString(16).padStart(2, '0')} len=${payload.length} fields=${fp} first${Math.min(64, payload.length)}=${payload.subarray(0, 64).toString('hex')}`,
            );
            summary.req.push({ f: flags, l: payload.length, fields: fp });
            if (want && idx < maxReqFrameBins)
              fs.writeFileSync(capFile(tag, id, idx, 'req'), payload);
          },
          (frame) => rawFrame('client', reqN)(frame),
        );
      },
      resData(chunk) {
        exact({ event: 'data', dir: 'server', chunk_b64: chunk.toString('base64') });
        if (!isProto || chunk.length === 0) return;
        if (!isStreaming) {
          log(
            `${tag}#${id} UNARY-RES chunk ${chunk.length}B first32=${chunk.subarray(0, 32).toString('hex')}`,
          );
          return;
        }
        parseFrames(
          stRes,
          chunk,
          ({ flags, payload, error }) => {
            const idx = resN++;
            const fp = fieldPath(payload, 2).join(' ');
            if (error) log(`${tag}#${id} RES frame[${idx}] gunzip fail ${error.message}`);
            log(
              `${tag}#${id} RES frame[${idx}] flags=0x${flags.toString(16).padStart(2, '0')} len=${payload.length} fields=${fp} first${Math.min(32, payload.length)}=${payload.subarray(0, 32).toString('hex')}`,
            );
            summary.res.push({ f: flags, l: payload.length, fields: fp });
            if (flags & 0x02)
              log(
                `${tag}#${id} RES trailer frame[${idx}] JSON=${payload.toString('utf8').slice(0, 400)}`,
              );
            if (want && idx < maxResFrameBins)
              fs.writeFileSync(capFile(tag, id, idx, 'res'), payload);
          },
          (frame) => rawFrame('server', resN)(frame),
        );
      },
      summary,
    };
  }

  const server = http2.createSecureServer({
    allowHTTP1: true,
    key: options.key,
    cert: options.cert,
  });

  const downstreamSessions = new Set();
  server.on('session', (s) => {
    const conn = `conn-${++connSeq}`;
    sessionConn.set(s, conn);
    downstreamSessions.add(s);
    s.on('close', () => downstreamSessions.delete(s));
    log(`H2 session open alpn=${s.socket.alpnProtocol} from ${s.socket.remoteAddress}`);
    lifecycle({
      conn,
      event: 'session_open',
      detail: { alpn: s.socket.alpnProtocol, remote: s.socket.remoteAddress },
    });
    s.on('goaway', (errorCode, lastStreamID) => {
      log(`H2 session goaway ${rstName(errorCode)} lastStream=${lastStreamID}`);
      lifecycle({
        conn,
        event: 'goaway',
        detail: {
          origin: 'downstream',
          error_code: errorCode,
          error: rstName(errorCode),
          last_stream_id: lastStreamID,
        },
      });
    });
    s.on('close', () => {
      log('H2 session close');
      lifecycle({ conn, event: 'session_close' });
    });
  });

  // one pooled upstream h2 session per proxy; keep every created session so a
  // GOAWAY'd idle one cannot leak past close(). Event handlers capture the
  // created session so they never null out a newer replacement.
  const upstreamSessions = new Set();
  let upstreamSession = null;
  let upstreamConn = null;
  let upstreamGoawayed = false;
  function getUpstream() {
    if (
      upstreamSession &&
      !upstreamSession.closed &&
      !upstreamSession.destroyed &&
      !upstreamGoawayed
    )
      return upstreamSession;
    const created = http2.connect(`https://${targetHost}`, upstreamTls);
    upstreamSessions.add(created);
    upstreamSession = created;
    upstreamGoawayed = false;
    upstreamConn = `upstream-${++upstreamSeq}`;
    const uconn = upstreamConn;
    lifecycle({
      conn: uconn,
      event: 'session_open',
      detail: { origin: 'upstream', target: targetHost },
    });
    created.on('goaway', (errorCode, lastStreamID) => {
      if (upstreamSession === created) upstreamGoawayed = true;
      log(`upstream h2 goaway ${rstName(errorCode)} lastStream=${lastStreamID}`);
      lifecycle({
        conn: uconn,
        event: 'goaway',
        detail: {
          origin: 'upstream',
          error_code: errorCode,
          error: rstName(errorCode),
          last_stream_id: lastStreamID,
        },
      });
    });
    created.on('error', (e) => {
      log(`upstream h2 error ${e.message}`);
      lifecycle({
        conn: uconn,
        event: 'session_close',
        detail: { origin: 'upstream', error: e.message },
      });
      if (upstreamSession === created) upstreamSession = null;
    });
    created.on('close', () => {
      log('upstream h2 session closed');
      lifecycle({ conn: uconn, event: 'session_close', detail: { origin: 'upstream' } });
      upstreamSessions.delete(created);
      if (upstreamSession === created) upstreamSession = null;
    });
    log(`upstream h2 connected to ${targetHost}`);
    return created;
  }

  server.on('stream', (stream, headers) => {
    const id = ++reqSeq;
    const method = headers[':method'];
    const spath = headers[':path'];
    const ctype = headers['content-type'];
    const tag = 'H2';
    const conn = sessionConn.get(stream.session) ?? 'conn-unknown';
    const streamId = stream.id;
    log(`${tag}#${id} >>> STREAM ${method} ${spath}`);
    logHeaders(tag, id, 'req', headers);
    lifecycle({
      conn,
      stream: streamId,
      event: 'open',
      detail: { method, path: spath, content_type: ctype },
    });
    const dataState = {
      req: { seen: false, last_mono_ms: null, frames: 0, bytes: 0 },
      res: { seen: false, last_mono_ms: null, frames: 0, bytes: 0 },
    };
    const lifecycleData = (dir, chunkLen) => {
      const s = dataState[dir];
      const first = !s.seen;
      s.seen = true;
      s.frames += 1;
      s.bytes += chunkLen;
      const mono = Math.round((performance.now() - monoStart) * 1000) / 1000;
      s.last_mono_ms = mono;
      lifecycle({
        conn,
        stream: streamId,
        event: 'data',
        detail: { dir, bytes: chunkLen, first, mono_ms: mono },
      });
    };
    const logger = makeStreamLogger(tag, id, spath, ctype, conn, streamId);
    stream.on('data', (c) => {
      lifecycleData('req', c.length);
      logger.reqData(c);
    });
    const up = getUpstream().request({
      ...fwdHeaders(headers),
      ':method': method,
      ':path': spath,
      ':authority': targetHost,
    });
    let responded = false;
    const failDownstream = (msg) => {
      log(`${tag}#${id} upstream error ${msg}`);
      try {
        if (!responded) {
          responded = true;
          stream.respond({ ':status': 502 });
        }
        stream.end();
      } catch {
        try {
          stream.close(http2.constants.NGHTTP2_CONNECT_ERROR);
        } catch {
          stream.destroy();
        }
      }
    };
    up.on('error', (e) => failDownstream(e.message));
    stream.pipe(up);
    stream.on('end', () => up.end());
    up.on('response', (rh) => {
      logHeaders(tag, id, 'res', rh);
      const outH = {};
      for (const [k, v] of Object.entries(rh))
        if (k[0] !== ':' && !DROP.has(k.toLowerCase())) outH[k] = v;
      try {
        stream.respond({ ':status': rh[':status'], ...outH });
        responded = true;
      } catch (e) {
        log(`respond err ${e instanceof Error ? e.message : String(e)}`);
      }
      if (
        rh['content-type'] &&
        /proto/.test(rh['content-type']) &&
        !/connect\+proto/.test(rh['content-type'])
      ) {
        const chunks = [];
        up.on('data', (c) => {
          lifecycleData('res', c.length);
          chunks.push(c);
        });
        up.on('end', () => {
          const body = Buffer.concat(chunks);
          log(
            `${tag}#${id} UNARY-RES full-body ${body.length}B first32=${body.subarray(0, 32).toString('hex')}`,
          );
          fs.writeFileSync(
            path.join(
              captureDir,
              `unary-${targetHost.replace(/[.:]/g, '-')}-${spath.replace(/[^\w.]/g, '_')}-${id}.bin`,
            ),
            body,
          );
          stream.end(body);
        });
      } else {
        up.on('data', (c) => {
          lifecycleData('res', c.length);
          logger.resData(c);
        });
        up.pipe(stream);
      }
    });
    const done = () => {
      log(
        `${tag}#${id} <<< STREAM closed. reqFrames=${logger.summary.req.length} resFrames=${logger.summary.res.length}`,
      );
      if (logger.summary.res.length)
        log(
          `${tag}#${id} RES seq: ${logger.summary.res.map((r) => `f${r.f}len${r.l}[${r.fields}]`).join(' -> ')}`,
        );
    };
    up.on('close', () => {
      done();
      const rst = up.rstCode;
      if (options.captureExact)
        lifecycle({
          conn,
          stream: streamId,
          event: 'upstream_close',
          detail: { origin: 'upstream', rst_code: rst, rst_name: rstName(rst) },
        });
      if (rst !== undefined && rst !== http2.constants.NGHTTP2_NO_ERROR) {
        lifecycle({
          conn,
          stream: streamId,
          event: 'rst',
          detail: { origin: 'upstream', error_code: rst, error: rstName(rst) },
        });
      }
    });
    stream.on('close', () => {
      const rst = stream.rstCode;
      const detail = {
        rst_code: rst,
        rst_name: rstName(rst),
        req_data_frames: dataState.req.frames,
        res_data_frames: dataState.res.frames,
        last_req_data_mono_ms: dataState.req.last_mono_ms,
        last_res_data_mono_ms: dataState.res.last_mono_ms,
      };
      if (rst !== http2.constants.NGHTTP2_NO_ERROR) {
        lifecycle({
          conn,
          stream: streamId,
          event: 'rst',
          detail: { origin: 'downstream', error_code: rst, error: rstName(rst) },
        });
        // propagate the abort upstream so upstream-side ordering is measurable too
        try {
          up.close(rst);
        } catch {
          up.destroy();
        }
      }
      lifecycle({ conn, stream: streamId, event: 'close', detail });
    });
    stream.on('error', (e) => log(`${tag}#${id} stream error ${e.message}`));
  });

  // ---------------- HTTP/1.1 fallback ----------------
  server.on('request', (req, res) => {
    if (req.httpVersion === '2.0') return;
    const id = ++reqSeq;
    const tag = 'H1';
    log(`${tag}#${id} >>> REQUEST ${req.method} ${req.url} http/${req.httpVersion}`);
    logHeaders(tag, id, 'req', req.headers);
    const logger = makeStreamLogger(tag, id, req.url, req.headers['content-type']);
    req.on('data', (c) => logger.reqData(c));
    const [hostOnly, portOnly] = (() => {
      const i = targetHost.lastIndexOf(':');
      return i > 0 ? [targetHost.slice(0, i), Number(targetHost.slice(i + 1))] : [targetHost, 443];
    })();
    const upReq = https.request(
      {
        host: hostOnly,
        port: portOnly,
        ...upstreamTls,
        method: req.method,
        path: req.url,
        headers: { ...fwdHeaders(req.headers), host: targetHost },
      },
      (upRes) => {
        logHeaders(tag, id, 'res', upRes.headers);
        const outH = {};
        for (const [k, v] of Object.entries(upRes.headers))
          if (!DROP.has(k.toLowerCase()) && k.toLowerCase() !== 'content-length') outH[k] = v;
        res.writeHead(upRes.statusCode, outH);
        const rct = upRes.headers['content-type'] || '';
        if (/proto/.test(rct) && !/connect\+proto/.test(rct)) {
          const chunks = [];
          upRes.on('data', (c) => chunks.push(c));
          upRes.on('end', () => {
            const body = Buffer.concat(chunks);
            log(
              `${tag}#${id} UNARY-RES full-body ${body.length}B first32=${body.subarray(0, 32).toString('hex')}`,
            );
            fs.writeFileSync(
              path.join(
                captureDir,
                `unary-${targetHost.replace(/[.:]/g, '-')}-${String(req.url).replace(/[^\w.]/g, '_')}-${id}.bin`,
              ),
              body,
            );
            res.end(body);
          });
        } else {
          upRes.on('data', (c) => logger.resData(c));
          upRes.pipe(res);
        }
        upRes.on('close', () => {
          log(
            `${tag}#${id} <<< REQUEST closed. reqFrames=${logger.summary.req.length} resFrames=${logger.summary.res.length}`,
          );
        });
      },
    );
    req.pipe(upReq);
    upReq.on('error', (e) => {
      log(`${tag}#${id} upstream err ${e.message}`);
      try {
        res.writeHead(502);
        res.end();
      } catch {
        /* downstream already gone */
      }
    });
  });

  server.on('unknownProtocol', (socket) => {
    log(`unknownProtocol ${socket.alpnProtocol}`);
    socket.destroy();
  });

  return {
    server,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port, '127.0.0.1', () => {
          const address = server.address();
          if (address === null || typeof address === 'string') {
            reject(new Error('proxy has no bound address'));
            return;
          }
          log(`listening on https://127.0.0.1:${address.port} -> https://${targetHost} (h2+h1)`);
          resolve(address);
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        const forceDestroy = () => {
          for (const session of upstreamSessions) {
            if (!session.destroyed) session.destroy();
          }
          upstreamSessions.clear();
          upstreamSession = null;
          for (const session of downstreamSessions) {
            if (!session.destroyed) session.destroy();
          }
        };
        forceDestroy();
        server.closeAllConnections?.();
        const timer = setTimeout(() => {
          forceDestroy();
          finish();
        }, 1_000);
        timer.unref?.();
        server.close(() => {
          clearTimeout(timer);
          finish();
        });
      });
    },
  };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key.startsWith('--')) throw new Error(`unexpected argument: ${key}`);
    out[key.slice(2)] = argv[i + 1];
  }
  return out;
}

function isMain() {
  return process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
}

if (isMain()) {
  const args = parseArgs(process.argv.slice(2));
  const required = ['port', 'target-host', 'cert', 'key', 'capture-dir'];
  for (const name of required) {
    if (!args[name]) {
      console.error(`missing --${name}`);
      process.exit(2);
    }
  }
  const maxReq =
    args['max-req-bins'] !== undefined ? Number(args['max-req-bins']) : MAX_REQ_FRAME_BINS;
  const maxRes =
    args['max-res-bins'] !== undefined ? Number(args['max-res-bins']) : MAX_RES_FRAME_BINS;
  if (!Number.isInteger(maxReq) || maxReq < 0) {
    console.error('invalid --max-req-bins');
    process.exit(2);
  }
  if (!Number.isInteger(maxRes) || maxRes < 0) {
    console.error('invalid --max-res-bins');
    process.exit(2);
  }
  const proxy = createCaptureProxy({
    port: Number(args.port),
    targetHost: args['target-host'],
    cert: fs.readFileSync(args.cert),
    key: fs.readFileSync(args.key),
    targetCa: args['target-ca'] ? fs.readFileSync(args['target-ca']) : undefined,
    captureDir: args['capture-dir'],
    maxReqFrameBins: maxReq,
    maxResFrameBins: maxRes,
  });
  proxy.listen().catch((e) => {
    console.error(e);
    process.exit(1);
  });
  const shutdown = () => {
    proxy.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

export {
  MAX_REQ_FRAME_BINS,
  MAX_RES_FRAME_BINS,
  SENSITIVE,
  createCaptureProxy,
  fieldPath,
  parseFrames,
  redactShape,
};
