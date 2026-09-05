/* global AbortSignal, process */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createToolState } from '../native-parity-mcp.mjs';
import { ROOT, SELF, DEADLINE, append, json } from './shared.mjs';
import { bounded, stopChild, trackedChild } from './processes.mjs';
import { promptFor, validateCase } from './cases.mjs';
import { runBridgeTurn } from './bridge-http.mjs';

export async function bridgeChild() {
  const { buildServer } = await import(pathToFileURL(path.join(ROOT, 'dist/server.js')).href);
  const { createConfiguredBackend } = await import(
    pathToFileURL(path.join(ROOT, 'dist/backend/auto.js')).href
  );
  // Never call loadConfig(): it implicitly loads .env and the user's dashboard.
  const config = {
    host: '127.0.0.1',
    port: 0,
    backend: 'cursor-api',
    defaultModel: 'composer-2.5',
    clientAuth: 'off',
    workspaceMode: 'real-workspace',
    realWorkspacePath: process.cwd(),
    version: 'native-parity-qa',
    dashboardConfig: {},
    cursorApiCredentials: [{ id: 'system', weight: 1, enabled: true }],
  };
  const backend = await createConfiguredBackend(config);
  const server = await buildServer({ config, backend });
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    try {
      await server.close();
      process.disconnect?.();
    } catch {
      process.exitCode = 1;
      process.disconnect?.();
    }
  };
  process.on('SIGTERM', () => void close());
  process.on('SIGINT', () => void close());
  const address = await server.listen({ host: '127.0.0.1', port: 0 });
  process.send?.({ type: 'ready', address });
}

export async function runBridge({
  workspace,
  laneDir,
  env,
  caseId,
  prompt,
  nextCode,
  api,
  agent,
  monitor,
  receipts,
  signal,
}) {
  const stderr = fs.openSync(path.join(laneDir, 'bridge.log'), 'w', 0o600);
  const resource = trackedChild(process.execPath, [SELF, '--bridge-child'], {
    cwd: workspace,
    env: {
      ...env,
      CURSOR_BRIDGE_BACKEND: 'cursor-api',
      CURSOR_BRIDGE_CURSOR_API_ENDPOINT: api,
      CURSOR_BRIDGE_CURSOR_AGENT_ENDPOINT: agent,
      CURSOR_BRIDGE_CURSOR_TIMEOUT_MS: String(DEADLINE),
      CURSOR_BRIDGE_AUTO_PROBE_TIMEOUT_MS: '30000',
    },
    stdio: ['ignore', stderr, stderr, 'ipc'],
  });
  try {
    const ready = new Promise((resolve) =>
      resource.child.on('message', (message) => {
        if (message.type === 'ready') resolve(message.address);
      }),
    );
    const address = await bounded(
      Promise.race([
        ready,
        resource.closed.then(() => {
          throw new Error('bridge_boot_failed');
        }),
      ]),
      45000,
      'bridge_boot_timeout',
      signal,
    );
    const state = createToolState(caseId, nextCode);
    const result = await runBridgeTurn({
      url: `${address}/v1/chat/completions`,
      caseId,
      prompt,
      state,
      signal: AbortSignal.any([signal, AbortSignal.timeout(DEADLINE)]),
      onEvent: (event) => append(path.join(laneDir, 'bridge.sse.jsonl'), event),
      onHttp: (event) => append(path.join(laneDir, 'bridge.http.jsonl'), event),
      onCancel: () => monitor.cancel(),
    });
    result.upstreamClosedBeforeCleanup = result.cancelled
      ? await monitor.waitForCancelledClose(signal)
      : false;
    if (result.cancelled && result.upstreamClosedBeforeCleanup) {
      const recovery = await runBridgeTurn({
        url: `${address}/v1/chat/completions`,
        caseId: 'chat',
        prompt: promptFor('chat'),
        state: createToolState('chat', nextCode),
        signal: AbortSignal.any([signal, AbortSignal.timeout(DEADLINE)]),
        onEvent: (event) => append(path.join(laneDir, 'recovery.sse.jsonl'), event),
        onHttp: (event) => append(path.join(laneDir, 'recovery.http.jsonl'), event),
      });
      result.recovery = validateCase('chat', recovery);
      json(path.join(laneDir, 'recovery.json'), recovery);
    }
    json(path.join(laneDir, 'tool-audit.json'), state.calls);
    return result;
  } finally {
    try {
      await stopChild(resource, 'bridge-server', receipts);
    } finally {
      fs.closeSync(stderr);
    }
  }
}
