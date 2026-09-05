/* global AbortController, AbortSignal, process */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { expect, it, vi } from 'vitest';
import * as native from '../scripts/native-parity-live.mjs';

it.each([
  'success',
  'repository-error',
  'worker-exit',
  'interrupt',
  'artifact-error',
  'bound-before-listen',
])('provisions private worker credentials and removes them after %s', async (scenario) => {
  // Given a real worker subprocess that requires file auth, not environment auth.
  const root = fs.mkdtempSync('/tmp/np-w-');
  const cli = path.join(root, 'cli.mjs');
  const home = path.join(root, 'home');
  const credential = path.join(home, 'xdg/cursor/auth.json');
  const controller = new AbortController();
  let refused = 0;
  const get = http.get;
  const transport = vi.spyOn(http, 'get').mockImplementation((...args) => {
    const request = get(...args);
    request.on('error', (error) => {
      if (scenario === 'bound-before-listen' && error.code === 'ECONNREFUSED') {
        refused++;
        fs.writeFileSync(path.join(root, 'listen-gate'), '');
      }
    });
    return request;
  });
  const watcher = fs.watch(root);
  watcher.on('change', (_event, filename) => {
    if (scenario === 'interrupt' && filename === 'worker-started') controller.abort();
  });
  fs.writeFileSync(
    cli,
    `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
const auth = path.join(process.env.XDG_CONFIG_HOME, 'cursor/auth.json');
if (process.argv[2] === 'worker-server') {
  const valid = JSON.parse(fs.readFileSync(auth)).accessToken === 'synthetic-token'
    && (fs.statSync(auth).mode & 0o777) === 0o600;
  if (!valid) process.exit(3);
  fs.writeFileSync('worker-started', String(process.pid));
  if (process.env.SCENARIO === 'worker-exit') process.exit(4);
  const server = http.createServer((req, res) => {
    if (process.env.SCENARIO === 'interrupt') return;
    fs.writeFileSync('repository-request', req.url);
    res.statusCode = process.env.SCENARIO === 'repository-error' ? 500 : 200;
    res.end(JSON.stringify({repoName:'fixture'}));
  });
  if (process.env.SCENARIO === 'bound-before-listen') {
    const gate = fs.watch(process.cwd());
    const bound = spawn('python3', ['-c', 'import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); sys.stdin.readline(); s.close()', process.env.AGENT_CLI_SOCKET_PATH]);
    gate.on('change', (_event, filename) => {
      if (filename === 'listen-gate') { gate.close(); bound.stdin.end('listen\\n'); }
    });
    bound.on('close', () => { fs.unlinkSync(process.env.AGENT_CLI_SOCKET_PATH); server.listen(process.env.AGENT_CLI_SOCKET_PATH); });
  } else server.listen(process.env.AGENT_CLI_SOCKET_PATH);
} else {
  process.stdin.resume();
  process.stdin.on('end', () => {
    if (fs.readFileSync('repository-request', 'utf8') !== '/getRepositoryInfo') process.exit(5);
    if (!fs.existsSync(auth)) process.exit(6);
    fs.writeFileSync('measured', '');
    console.log(JSON.stringify({type:'result',subtype:'success',result:'WIRE_OK',is_error:false}));
  });
}
`,
    { mode: 0o700 },
  );
  if (scenario === 'artifact-error') fs.mkdirSync(path.join(root, 'worker-readiness.json'));
  const receipts = [];
  try {
    // When the production prepared lane runs (subscription predates subprocess startup).
    const result = native.runPreparedNative({
      cli,
      workspace: root,
      laneDir: root,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        XDG_CONFIG_HOME: path.join(home, 'xdg'),
        CURSOR_DATA_DIR: path.join(home, 'data'),
        CURSOR_AUTH_TOKEN: 'synthetic-token',
        AGENT_CLI_CREDENTIAL_STORE: 'file',
        SCENARIO: scenario,
      },
      caseId: 'chat',
      prompt: 'WIRE_OK',
      api: 'https://127.0.0.1:1',
      agent: 'https://127.0.0.1:2',
      monitor: {},
      receipts,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
    });
    // Then only an authenticated, ready worker permits measured chat; all paths erase auth.
    const success = scenario === 'success' || scenario === 'bound-before-listen';
    if (success) expect((await result).terminal).toBe(true);
    else
      await expect(result).rejects.toThrow(
        {
          'repository-error': 'native_worker_repository_unavailable',
          'worker-exit': 'native_worker_exited_before_ready',
          interrupt: 'interrupted',
          'artifact-error': 'EISDIR',
        }[scenario],
      );
    expect(fs.existsSync(path.join(root, 'measured'))).toBe(success);
    if (scenario === 'bound-before-listen') expect(refused).toBeGreaterThan(0);
    expect(fs.existsSync(credential)).toBe(false);
    expect(receipts.find((r) => r.role === 'native-worker')?.ok).toBe(true);
    expect(receipts.find((r) => r.role === 'native-credentials')?.ok).toBe(true);
    expect(receipts.every((r) => r.ok)).toBe(true);
  } finally {
    transport.mockRestore();
    watcher.close();
    const started = path.join(root, 'worker-started');
    if (fs.existsSync(started))
      execFileSync('python3', [
        'scripts/native-parity-process-exit.py',
        fs.readFileSync(started, 'utf8'),
      ]);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
