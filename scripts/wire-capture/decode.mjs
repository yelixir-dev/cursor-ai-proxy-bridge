#!/usr/bin/env node
// Minimal raw protobuf decoder - prints the field tree with string inference.
// Ported from /tmp/cursor-mitm/decode.mjs.
// Usage: node decode.mjs <capture.bin>
import fs from 'node:fs';

function varint(b, p) {
  let v = 0n,
    s = 0n;
  for (;;) {
    if (p >= b.length) return null;
    const x = b[p++];
    v |= BigInt(x & 0x7f) << s;
    if (!(x & 0x80)) return { v: Number(v), p };
    s += 7n;
    if (s > 63n) return null;
  }
}

function looksUtf8(b) {
  try {
    const s = new TextDecoder('utf8', { fatal: true }).decode(b);
    return /^[\x09\x0a\x0d\x20-\x7e -￿]*$/.test(s) && s.length > 0;
  } catch {
    return false;
  }
}

function walkInto(b, depth, path, lines) {
  let p = 0,
    count = 0;
  while (p < b.length && count++ < 200) {
    const t = varint(b, p);
    if (!t) break;
    p = t.p;
    const no = t.v >>> 3,
      wt = t.v & 7;
    const ind = '  '.repeat(depth);
    if (wt === 0) {
      const v = varint(b, p);
      if (!v) break;
      p = v.p;
      lines.push(`${ind}${path}${no}: varint ${v.v}`);
    } else if (wt === 1) {
      p += 8;
      lines.push(`${ind}${path}${no}: fixed64`);
    } else if (wt === 5) {
      p += 4;
      lines.push(`${ind}${path}${no}: fixed32`);
    } else if (wt === 2) {
      const l = varint(b, p);
      if (!l) break;
      p = l.p;
      const sub = b.subarray(p, p + l.v);
      p += l.v;
      if (looksUtf8(sub) && sub.length < 200)
        lines.push(`${ind}${path}${no}: str(${sub.length}) "${sub.toString().slice(0, 120)}"`);
      else if (sub.length === 0) lines.push(`${ind}${path}${no}: bytes(0)`);
      else {
        lines.push(`${ind}${path}${no}: msg(${sub.length}) {`);
        walkInto(sub, depth + 1, '', lines);
        lines.push(`${ind}}`);
      }
    } else break;
  }
}

function decodeTree(buf) {
  const lines = [];
  walkInto(buf, 0, 'f', lines);
  return lines;
}

function isMain() {
  return process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
}

if (isMain()) {
  if (!process.argv[2]) {
    console.error('usage: node decode.mjs <capture.bin>');
    process.exit(2);
  }
  for (const line of decodeTree(fs.readFileSync(process.argv[2]))) console.log(line);
}

export { decodeTree };
