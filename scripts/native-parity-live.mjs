#!/usr/bin/env node
/* global console, process */
import { pathToFileURL } from 'node:url';
import { generateCerts } from './wire-capture/gen-certs.mjs';
import { parseArgs } from './native-parity/cases.mjs';
import { bridgeChild } from './native-parity/bridge.mjs';
import { runLive } from './native-parity/driver.mjs';

export { parseArgs, promptFor, validateCase } from './native-parity/cases.mjs';
export { nativeText, runNative } from './native-parity/native.mjs';
export { runPreparedNative } from './native-parity/worker.mjs';
export { createSseParser, runBridgeTurn } from './native-parity/bridge-http.mjs';
export { bounded, stopChild } from './native-parity/processes.mjs';
export { lifecycleMonitor } from './native-parity/lifecycle.mjs';
export { analyzeFrames } from './native-parity/capture-analysis.mjs';
export { buildBridge, generateCaptureCerts } from './native-parity/prerequisites.mjs';
export { runLive };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === '--cert-child') {
    try {
      generateCerts({ out: process.argv[3] });
    } catch {
      console.error('native-parity certificate generation failed');
      process.exitCode = 1;
    }
  } else if (process.argv[2] === '--bridge-child')
    bridgeChild().catch(() => {
      console.error('native-parity bridge child failed');
      process.exitCode = 1;
      process.disconnect?.();
    });
  else if (process.argv.includes('--help'))
    console.log(
      'node scripts/native-parity-live.mjs --case chat|parallel|sequential|cancel --evidence-dir NEW_DIRECTORY\nRequired: fresh CURSOR_AUTH_TOKEN. Optional: NATIVE_PARITY_CURSOR_BIN. Rebuilds dist, then live inference runs native followed by bridge. Raw evidence is private.',
    );
  else
    runLive(parseArgs(process.argv.slice(2))).then(
      (summary) => {
        console.log(`native-parity ${summary.ok ? 'passed' : 'failed'}; see summary.json`);
        process.exitCode = summary.ok ? 0 : 1;
      },
      () => {
        console.error('native-parity failed; check prerequisites and private evidence');
        process.exitCode = 1;
      },
    );
}
