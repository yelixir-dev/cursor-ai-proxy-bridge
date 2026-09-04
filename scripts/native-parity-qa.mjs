#!/usr/bin/env node
/* global console, process */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { register } from 'tsx/esm/api';
import { register as registerCommonJs } from 'tsx/cjs/api';

const { values } = parseArgs({
  options: {
    case: { type: 'string' },
    'evidence-dir': { type: 'string' },
  },
});
if (!['resume-contract', 'credential-isolation'].includes(values.case) || !values['evidence-dir']) {
  throw new Error(
    'Usage: node scripts/native-parity-qa.mjs --case resume-contract|credential-isolation --evidence-dir PATH',
  );
}
registerCommonJs();
register();
const { runCase } = await import('../tests/support/native-parity-scenarios.ts');
const directory = resolve(values['evidence-dir'], values.case);
await mkdir(directory, { recursive: true });
const receipts = [];
let failure;
try {
  await runCase(values.case, async (receipt) => {
    receipts.push(receipt);
    await writeFile(
      join(directory, receipt.name + '.json'),
      JSON.stringify(receipt, null, 2) + '\n',
    );
  });
} catch (error) {
  failure = error instanceof Error ? (error.stack ?? error.message) : String(error);
}
const result = {
  case: values.case,
  pass: failure === undefined,
  liveCursorCalls: 0,
  scenarios: receipts.map(({ name, pass }) => ({ name, pass })),
  evidenceDirectory: directory,
  cleanup: receipts.map(({ name, cleanup }) => ({ name, ...cleanup })),
  ...(failure === undefined ? {} : { error: failure }),
};
await writeFile(join(directory, 'summary.json'), JSON.stringify(result, null, 2) + '\n');
// Every receipt is emitted only after its listener and synthetic transport shut down.
console.log(JSON.stringify(result));
if (failure !== undefined) process.exitCode = 1;
