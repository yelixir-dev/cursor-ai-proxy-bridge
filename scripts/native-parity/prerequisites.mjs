/* global Buffer, process */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, SELF, sha } from './shared.mjs';
import { bounded, stopChild, trackedChild } from './processes.mjs';

export function minimalEnvironment(home, ca) {
  const env = {};
  for (const key of ['PATH', 'TMPDIR', 'LANG', 'LC_ALL'])
    if (process.env[key]) env[key] = process.env[key];
  return {
    ...env,
    HOME: home,
    CURSOR_CONFIG_DIR: path.join(home, 'config'),
    CURSOR_DATA_DIR: path.join(home, 'data'),
    XDG_CONFIG_HOME: path.join(home, 'xdg'),
    NODE_COMPILE_CACHE: path.join(home, 'compile-cache'),
    NO_COLOR: '1',
    NODE_EXTRA_CA_CERTS: ca,
    AGENT_CLI_CREDENTIAL_STORE: 'file',
    CURSOR_AUTH_TOKEN: process.env.CURSOR_AUTH_TOKEN,
  };
}

export function hashedAccount(token) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('CURSOR_AUTH_TOKEN_must_be_JWT');
  let claims;
  try {
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  } catch {
    throw new Error('invalid_auth_claims');
  }
  if (
    typeof claims.sub !== 'string' ||
    !claims.sub ||
    typeof claims.exp !== 'number' ||
    claims.exp * 1000 < Date.now() + 300000
  )
    throw new Error('fresh_auth_claims_required');
  return {
    sub_sha256: sha(claims.sub),
    claim_match: true,
    cryptographic_identity_proven: false,
    credential_source: 'same_inherited_CURSOR_AUTH_TOKEN',
  };
}

export async function buildBridge(rawDir, receipts, signal) {
  const home = path.join(rawDir, 'build-home');
  fs.mkdirSync(home);
  const log = fs.openSync(path.join(rawDir, 'build.log'), 'w', 0o600);
  const resource = trackedChild('npm', ['run', 'build'], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR },
    stdio: ['ignore', log, log],
  });
  try {
    const exit = await bounded(resource.closed, 90000, 'build_timeout', signal);
    if (exit.code !== 0) throw new Error('build_failed');
    return {
      command: 'npm run build',
      exit_code: exit.code,
      dist_sha256: sha(
        JSON.stringify(
          fs
            .readdirSync(path.join(ROOT, 'dist'), { recursive: true })
            .filter((name) => /\.(js|json)$/.test(name))
            .sort()
            .map((name) => [name, sha(fs.readFileSync(path.join(ROOT, 'dist', name)))]),
        ),
      ),
      descriptor_bundle_version: JSON.parse(
        fs.readFileSync(path.join(ROOT, 'dist/backend/cursor-api/proto-descriptors.json'), 'utf8'),
      ).bundleVersion,
      server_sha256: sha(fs.readFileSync(path.join(ROOT, 'dist/server.js'))),
      descriptors_sha256: sha(
        fs.readFileSync(path.join(ROOT, 'dist/backend/cursor-api/proto-descriptors.json')),
      ),
    };
  } finally {
    try {
      await stopChild(resource, 'bridge-build', receipts);
    } finally {
      fs.closeSync(log);
    }
  }
}

export async function generateCaptureCerts(out, receipts, signal) {
  const log = fs.openSync(path.join(path.dirname(out), 'certs.log'), 'w', 0o600);
  const resource = trackedChild(process.execPath, [SELF, '--cert-child', out], {
    cwd: path.dirname(out),
    env: { PATH: process.env.PATH },
    stdio: ['ignore', log, log],
  });
  try {
    const exit = await bounded(resource.closed, 15000, 'cert_timeout', signal);
    if (exit.code !== 0) throw new Error('cert_generation_failed');
    return {
      caCrt: path.join(out, 'ca.crt'),
      leafCrt: path.join(out, 'leaf.crt'),
      leafKey: path.join(out, 'leaf.key'),
    };
  } finally {
    try {
      await stopChild(resource, 'cert-generator', receipts);
    } finally {
      fs.closeSync(log);
    }
  }
}
