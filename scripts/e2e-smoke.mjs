#!/usr/bin/env node
/* global console, process */
import {
  createTraceProvenance,
  triggerAndAwaitAbortQuiescence,
} from '../dist/e2e/trace-provenance.js';
import { BACKEND, HOST } from './e2e/config.mjs';
import { formatTable, runScenario } from './e2e/reporter.mjs';
import { createScenarios } from './e2e/scenarios.mjs';
import { bootServer, ephemeralPort, stopServer } from './e2e/server.mjs';

const results = [];
const serverState = {
  process: undefined,
  exit: undefined,
  output: '',
  stderrPending: '',
};
const traceProvenance = await createTraceProvenance();
let exitCode = 1;

try {
  const port = await ephemeralPort();
  const baseUrl = `http://${HOST}:${port}`;
  await bootServer(serverState, port, traceProvenance);
  const scenarios = createScenarios({
    baseUrl,
    traceProvenance,
    triggerAndAwaitAbortQuiescence,
  });
  for (const scenario of scenarios) {
    await runScenario(results, scenario.id, scenario.run);
  }
  exitCode = results.every((row) => row.result === 'PASS') ? 0 : 1;
} catch (error) {
  console.error(error instanceof Error ? error.stack : error);
} finally {
  await stopServer(serverState);
  console.log(formatTable(results, BACKEND));
  if (exitCode !== 0 && serverState.output) {
    console.error(`\nServer output (tail):\n${serverState.output.slice(-4_000)}`);
  }
  if (serverState.stderrPending.trim()) traceProvenance.ingest(serverState.stderrPending);
  const receipt = await traceProvenance.finish({ failed: exitCode !== 0 });
  if (receipt.retained) {
    console.error(`bridge trace retained at: ${receipt.trace_path}`);
    console.error(`trace receipt: ${traceProvenance.receiptPath}`);
  } else {
    console.log(`bridge trace sanitized and cleaned (${receipt.record_count} records)`);
  }
  process.exitCode = exitCode;
}
