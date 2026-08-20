/* global process, setTimeout */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { serverEnvironment } from '../../dist/e2e/trace-provenance.js';
import { API_KEY, BACKEND, HOST, SERVER_ARGV } from './config.mjs';
import { assert } from './http.mjs';

export function deadline(ms, message) {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
  });
}

export async function ephemeralPort() {
  const socket = createServer();
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, HOST, resolve);
  });
  const address = socket.address();
  assert(address && typeof address === 'object', 'could not allocate an ephemeral port');
  const port = address.port;
  await new Promise((resolve, reject) =>
    socket.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

export async function bootServer(state, port, traceProvenance) {
  const child = spawn(process.execPath, SERVER_ARGV, {
    cwd: process.cwd(),
    env: serverEnvironment(process.env, {
      CURSOR_BRIDGE_HOST: HOST,
      CURSOR_BRIDGE_PORT: String(port),
      CURSOR_BRIDGE_API_KEY: API_KEY,
      CURSOR_BRIDGE_BACKEND: BACKEND,
      CURSOR_BRIDGE_CURSOR_BIN: process.env.CURSOR_BRIDGE_CURSOR_BIN || 'cursor-agent',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  state.process = child;
  state.exit = new Promise((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  );

  let stdout = '';
  let listeningResolve;
  let listeningReject;
  const listening = new Promise((resolve, reject) => {
    listeningResolve = resolve;
    listeningReject = reject;
  });
  const capture = (chunk, isStdout) => {
    const text = chunk.toString('utf8');
    state.output += text;
    if (isStdout) {
      stdout += text;
      if (stdout.split(/\r?\n/).some((line) => line.includes('cursor-ai-bridge listening on'))) {
        listeningResolve();
      }
    } else {
      state.stderrPending += text;
      const lines = state.stderrPending.split('\n');
      state.stderrPending = lines.pop() ?? '';
      for (const line of lines) traceProvenance.ingest(line);
    }
  };
  child.stdout.on('data', (chunk) => capture(chunk, true));
  child.stderr.on('data', (chunk) => capture(chunk, false));
  child.once('error', listeningReject);
  child.once('exit', (code, signal) => {
    listeningReject(new Error(`server exited before listening (code=${code}, signal=${signal})`));
  });
  await Promise.race([listening, deadline(30_000, 'server listen deadline exceeded')]);
}

export async function stopServer(state) {
  const child = state.process;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  try {
    await Promise.race([state.exit, deadline(10_000, 'server shutdown deadline exceeded')]);
  } catch {
    child.kill('SIGKILL');
    await state.exit;
  }
}
