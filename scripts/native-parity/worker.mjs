/* global AbortSignal, process */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { bounded, stopChild, trackedChild } from './processes.mjs';
import { runNative } from './native.mjs';

export async function runPreparedNative(options) {
  const { workspace, env, laneDir, receipts, signal } = options;
  // These locations match the native file credential manager, not CURSOR_CONFIG_DIR.
  const credentialDirectory =
    process.platform === 'darwin'
      ? path.join(env.HOME, '.cursor')
      : process.platform === 'win32'
        ? path.join(env.APPDATA ?? path.join(env.HOME, 'AppData/Roaming'), 'Cursor')
        : path.join(env.XDG_CONFIG_HOME, 'cursor');
  const credential = path.join(credentialDirectory, 'auth.json');
  let credentialOwned = false;
  let worker;
  let watcher;
  let log;
  try {
    signal?.throwIfAborted();
    fs.mkdirSync(credentialDirectory, { recursive: true, mode: 0o700 });
    const fd = fs.openSync(credential, 'wx', 0o600);
    credentialOwned = true;
    try {
      fs.writeFileSync(fd, JSON.stringify({ accessToken: env.CURSOR_AUTH_TOKEN }));
    } finally {
      fs.closeSync(fd);
    }
    let base = path.join(env.CURSOR_DATA_DIR, 'projects');
    if (base.length > 84) base = env.CURSOR_DATA_DIR;
    if (base.length > 84) base = '/tmp/.cursor';
    const projectPath = path.join(
      base,
      workspace.replace(/^\/+/, '').replace(/[^a-zA-Z0-9]+/g, '-'),
    );
    const project =
      projectPath.length > 92
        ? `${projectPath.substring(0, 84)}-${createHash('sha256').update(projectPath).digest('hex').substring(0, 7)}`
        : projectPath;
    fs.mkdirSync(project, { recursive: true });
    const socket = path.join(project, 'worker.sock');
    log = fs.openSync(path.join(laneDir, 'worker-process.private.log'), 'wx', 0o600);
    watcher = fs.watch(project);
    const ready = new Promise((resolve, reject) => {
      watcher.on('error', reject);
      watcher.on('change', (_event, filename) => {
        if (filename === 'worker.sock' && fs.existsSync(socket)) resolve();
      });
    });
    worker = trackedChild(options.cli, ['worker-server'], {
      cwd: workspace,
      env: {
        ...env,
        AGENT_CLI_SOCKET_PATH: socket,
        AGENT_CLI_LOG_PATH: path.join(laneDir, 'worker.private.log'),
        AGENT_CLI_WORKER_OPTIONS: JSON.stringify({
          endpoint: options.api,
          insecure: false,
          httpVersion: '1.1',
          repoEndpoint: 'https://repo42.cursor.sh',
          repoInsecure: false,
          repoHttpVersion: '1.1',
          enableCodebaseTelemetrySync: false,
        }),
      },
      stdio: ['ignore', log, log],
    });
    await bounded(
      Promise.race([
        ready,
        worker.closed.then(() => {
          throw new Error('native_worker_exited_before_ready');
        }),
      ]),
      30000,
      'native_worker_ready_timeout',
      signal,
    );
    watcher.close();
    const requestSignal = AbortSignal.any([
      ...(signal ? [signal] : []),
      AbortSignal.timeout(30000),
    ]);
    const status = await new Promise((resolve, reject) => {
      const connect = () => {
        const request = http.get(
          { socketPath: socket, path: '/getRepositoryInfo', signal: requestSignal },
          (response) => {
            response.on('error', reject);
            response.on('end', () => resolve(response.statusCode));
            response.resume();
          },
        );
        request.on('error', (error) => {
          // A socket path is visible at bind, before listen. Retry only transport
          // startup failures, driven by completion events and the same deadline.
          if (!requestSignal.aborted && ['ECONNREFUSED', 'ENOENT'].includes(error.code)) connect();
          else reject(signal?.aborted ? new Error('interrupted') : error);
        });
      };
      connect();
    });
    // Keep evidence I/O in the awaited control flow so failures run owned cleanup.
    fs.writeFileSync(path.join(laneDir, 'worker-readiness.json'), JSON.stringify({ status }), {
      mode: 0o600,
    });
    if (status !== 200) throw new Error('native_worker_repository_unavailable');
    return await runNative(options);
  } finally {
    watcher?.close();
    try {
      if (worker) await stopChild(worker, 'native-worker', receipts);
    } finally {
      try {
        if (log !== undefined) fs.closeSync(log);
      } finally {
        if (credentialOwned) {
          const receipt = { role: 'native-credentials', path: credential, mode: '0600', ok: false };
          receipts.push(receipt);
          fs.rmSync(credential, { force: true });
          receipt.ok = true;
        }
      }
    }
  }
}
