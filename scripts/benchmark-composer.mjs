#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';

const args = process.argv.slice(2);
const outputIndex = args.indexOf('--output');
const output = resolve(
  outputIndex >= 0 && args[outputIndex + 1]
    ? args[outputIndex + 1]
    : '.omo/evidence/cursor-composer-parity-benchmark/composer-parity.json',
);
const directory = dirname(output);
const name = basename(output).endsWith('.json') ? basename(output).slice(0, -5) : basename(output);
const artifactPaths = [
  output,
  resolve(directory, `${name}.md`),
  resolve(directory, `${name}.bridge-trace.jsonl`),
  resolve(directory, `${name}.versions-environment.json`),
  resolve(directory, `${name}.command-exit.json`),
  resolve(directory, `${name}.cleanup.json`),
];

async function invalidateArtifacts() {
  await Promise.all(artifactPaths.map((path) => rm(path, { force: true })));
  try {
    const entries = await readdir(directory);
    const prefixes = artifactPaths.map((path) => `${basename(path)}.tmp-`);
    await Promise.all(
      entries
        .filter((entry) => prefixes.some((prefix) => entry.startsWith(prefix)))
        .map((entry) => rm(resolve(directory, entry), { force: true })),
    );
  } catch {
    // A missing output directory is already invalidated.
  }
}

async function failureReceipt(exitCode, stage) {
  await invalidateArtifacts();
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, `${name}.command-exit.json`);
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(
    temporary,
    `${JSON.stringify(
      {
        schema_version: 'cursor-composer-parity-command-exit/v1',
        completed: true,
        exit_code: exitCode,
        verdict: 'infra_fail',
        stage,
      },
      null,
      2,
    )}\n`,
  );
  await rename(temporary, path);
}

let activeChild;
const forward = (signal) => activeChild?.kill(signal);
process.on('SIGINT', forward);
process.on('SIGTERM', forward);

function run(command, commandArgs, deadlineMs) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, commandArgs, { env: process.env, stdio: 'inherit' });
    activeChild = child;
    const timer =
      deadlineMs === undefined
        ? undefined
        : setTimeout(() => child.kill('SIGKILL'), deadlineMs).unref();
    child.once('error', rejectRun);
    child.once('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      if (activeChild === child) activeChild = undefined;
      resolveRun({ code: code ?? 5, signal });
    });
  });
}

try {
  await invalidateArtifacts();
  const npmCli = process.env.npm_execpath;
  const build = npmCli
    ? await run(process.execPath, [npmCli, 'run', 'build'], 180_000)
    : await run('npm', ['run', 'build'], 180_000);
  if (build.code !== 0 || build.signal !== null) {
    await failureReceipt(build.code || 5, 'build');
    process.exitCode = build.code || 5;
  } else {
    const benchmark = await run(process.execPath, ['dist/benchmark/cli.js', ...args]);
    process.exitCode = benchmark.code;
  }
} finally {
  process.removeListener('SIGINT', forward);
  process.removeListener('SIGTERM', forward);
}
