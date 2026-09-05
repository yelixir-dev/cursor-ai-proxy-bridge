import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const SELF = path.join(ROOT, 'scripts/native-parity-live.mjs');
export const MCP = path.join(ROOT, 'scripts/native-parity-mcp.mjs');
export const DEADLINE = 120_000;
export const sha = (value) => createHash('sha256').update(value).digest('hex');
export const json = (file, value) =>
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
export const append = (file, value) =>
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
export const readLines = (file) =>
  fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse)
    : [];
