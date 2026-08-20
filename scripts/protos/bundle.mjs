/* global process */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT_TYPES } from './contracts.mjs';

function executablePath(raw) {
  if (!raw) return undefined;
  const candidate = raw.includes(path.sep)
    ? path.resolve(raw)
    : execFileSync('/usr/bin/which', [raw], { encoding: 'utf8' }).trim();
  return fs.realpathSync(candidate);
}

export function resolveBundleDir(argv = process.argv, env = process.env) {
  const explicit = argv[2];
  if (explicit) return path.resolve(explicit);
  const configured = env.CURSOR_BRIDGE_CURSOR_BIN;
  if (configured) {
    try {
      const executable = executablePath(configured);
      if (executable && fs.existsSync(path.join(path.dirname(executable), 'index.js'))) {
        return path.dirname(executable);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Could not resolve CURSOR_BRIDGE_CURSOR_BIN=${JSON.stringify(configured)}: ${message}`,
        { cause: error },
      );
    }
  }
  const versions = path.join(os.homedir(), '.local', 'share', 'cursor-agent', 'versions');
  const candidates = fs.existsSync(versions)
    ? fs
        .readdirSync(versions)
        .filter((name) => fs.existsSync(path.join(versions, name, 'index.js')))
        .sort()
    : [];
  const latest = candidates.at(-1);
  if (!latest) {
    throw new Error(
      'No cursor-agent bundle found. Set CURSOR_BRIDGE_CURSOR_BIN to the installed cursor-agent executable.',
    );
  }
  return path.join(versions, latest);
}

export function collectTypes(loader) {
  const types = new Map();
  const indexType = (type) => {
    if (typeof type !== 'function' || !type.typeName || !type.fields || types.has(type.typeName)) {
      return;
    }
    types.set(type.typeName, type);
    for (const field of type.fields.list()) {
      if (field.kind === 'message' && typeof field.T === 'function') indexType(field.T);
      if (field.kind === 'map' && field.V?.kind === 'message' && typeof field.V.T === 'function') {
        indexType(field.V.T);
      }
    }
  };

  for (const key of loader.keys().filter((key) => key.includes('proto/dist/generated/'))) {
    try {
      for (const value of Object.values(loader.load(key))) indexType(value);
    } catch {
      // Unrelated generated modules can require lazy chunks; required roots below stay authoritative.
    }
  }
  for (const root of ROOT_TYPES) {
    if (!types.has(root)) {
      throw new Error(`Required protobuf type not found in installed bundle: ${root}`);
    }
    indexType(types.get(root));
  }
  return types;
}
