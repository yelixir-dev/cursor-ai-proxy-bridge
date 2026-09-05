/* global clearTimeout, process, setTimeout */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT } from './shared.mjs';

export function bounded(promise, milliseconds, label, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    };
    const abort = () => {
      cleanup();
      reject(new Error('interrupted'));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(label));
    }, milliseconds);
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

export function signalGroup(child, signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

export function trackedChild(command, args, options) {
  const child = spawn(command, args, { ...options, detached: true });
  const closed = new Promise((resolve) => {
    child.once('error', (error) => resolve({ spawnError: error.code ?? 'spawn_error' }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  return { child, closed };
}

export async function stopChild(resource, role, receipts) {
  const { child, closed } = resource;
  const receipt = { role, pid: child.pid ?? null, escalated: false, ok: false };
  receipts.push(receipt);
  const killAndObserve = async () => {
    receipt.escalated = true;
    const observer = spawn(
      'python3',
      [path.join(ROOT, 'scripts/native-parity-process-exit.py'), String(child.pid)],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    let errors = '';
    observer.stdout.on('data', (chunk) => {
      output += chunk;
    });
    observer.stderr.on('data', (chunk) => {
      errors += chunk;
    });
    const observed = new Promise((resolve, reject) => {
      observer.once('error', reject);
      observer.once('close', (code) => resolve(code));
    });
    const observerClosed = new Promise((resolve) => observer.once('close', resolve));
    try {
      const code = await bounded(observed, 5000, 'group_exit_timeout');
      if (code !== 0) throw new Error(`group_exit_observer_failed: ${errors.trim()}`);
      receipt.groupExit = JSON.parse(output);
      if (receipt.groupExit.remainingPids.length) receipt.lingeringGroup = true;
    } catch (error) {
      // Observation failure must not prevent best-effort owned-group cleanup.
      signalGroup(child, 'SIGKILL');
      throw error;
    } finally {
      if (observer.exitCode === null && observer.signalCode === null) observer.kill('SIGKILL');
      await bounded(observerClosed, 3000, 'observer_close_timeout');
    }
  };
  signalGroup(child, 'SIGTERM');
  try {
    receipt.exit = await bounded(closed, 3000, 'close_timeout');
  } catch {
    await killAndObserve();
    receipt.exit = await bounded(closed, 3000, 'kill_timeout');
  }
  // Reaped parent does not establish that detached descendants are gone.
  if (!receipt.escalated && child.pid && alive(-child.pid)) await killAndObserve();
  receipt.ok = !receipt.lingeringGroup;
}
