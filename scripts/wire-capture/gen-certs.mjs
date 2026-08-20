#!/usr/bin/env node
/* global URL, console, process */
// Regenerate the wire-capture CA + leaf certificate pair via openssl.
// The /tmp/cursor-mitm cert material is volatile; nothing outside --out is touched.
// Usage: node gen-certs.mjs --out <dir> [--days 7]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function generateCerts({ out, days = 7 }) {
  fs.mkdirSync(out, { recursive: true });
  const caKey = path.join(out, 'ca.key');
  const caCrt = path.join(out, 'ca.crt');
  const leafKey = path.join(out, 'leaf.key');
  const leafCsr = path.join(out, 'leaf.csr');
  const leafCrt = path.join(out, 'leaf.crt');
  const sanFile = path.join(out, 'leaf-san.ext');
  // -set_serial instead of -CAcreateserial: LibreSSL drops its serial file in
  // the process cwd under some invocations, polluting the caller's tree.
  const run = (args) =>
    execFileSync('openssl', args, { cwd: out, stdio: ['ignore', 'ignore', 'pipe'] });

  run(['genrsa', '-out', caKey, '2048']);
  run([
    'req',
    '-x509',
    '-new',
    '-nodes',
    '-key',
    caKey,
    '-sha256',
    '-days',
    String(days),
    '-out',
    caCrt,
    '-subj',
    '/CN=wire-capture-local-ca',
  ]);
  run(['genrsa', '-out', leafKey, '2048']);
  run(['req', '-new', '-key', leafKey, '-out', leafCsr, '-subj', '/CN=127.0.0.1']);
  fs.writeFileSync(
    sanFile,
    ['subjectAltName=IP:127.0.0.1,DNS:localhost', 'extendedKeyUsage=serverAuth'].join('\n') + '\n',
  );
  run([
    'x509',
    '-req',
    '-in',
    leafCsr,
    '-CA',
    caCrt,
    '-CAkey',
    caKey,
    '-set_serial',
    String(Date.now()),
    '-out',
    leafCrt,
    '-days',
    String(days),
    '-sha256',
    '-extfile',
    sanFile,
  ]);
  fs.rmSync(leafCsr, { force: true });
  fs.rmSync(sanFile, { force: true });
  fs.chmodSync(caKey, 0o600);
  fs.chmodSync(leafKey, 0o600);
  return { caCrt, caKey, leafCrt, leafKey };
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
  if (!args.out) {
    console.error('usage: node gen-certs.mjs --out <dir> [--days 7]');
    process.exit(2);
  }
  const files = generateCerts({
    out: args.out,
    days: args.days ? Number(args.days) : 7,
  });
  console.log(`wrote ${Object.values(files).join(', ')}`);
}

export { generateCerts };
