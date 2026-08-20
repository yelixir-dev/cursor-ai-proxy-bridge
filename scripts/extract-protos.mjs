#!/usr/bin/env node
/* global console */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeLoader } from './webpack-shim.mjs';
import { collectTypes, resolveBundleDir } from './protos/bundle.mjs';
import { buildDescriptorOutput, serializeDescriptorOutput } from './protos/descriptors.mjs';

const bundleDir = resolveBundleDir();
const types = collectTypes(makeLoader(bundleDir));
const versionName = path.basename(bundleDir);
const output = buildDescriptorOutput({
  types,
  bundleVersion: versionName,
  extractedAt: new Date().toISOString(),
});
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = path.join(repoRoot, 'src', 'backend', 'cursor-api', 'proto-descriptors.json');
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, serializeDescriptorOutput(output));
console.log(
  `Extracted ${Object.keys(output.messages).length} reachable message descriptors from ${bundleDir}`,
);
console.log(`Wrote ${outputPath}`);
