import fs from 'node:fs';
import path from 'node:path';
import { createCaptureProxy } from '../wire-capture/proxy.mjs';
import { bounded } from './processes.mjs';
import { lifecycleMonitor } from './lifecycle.mjs';
import { runPreparedNative } from './worker.mjs';
import { runBridge } from './bridge.mjs';

export async function captureLane(options) {
  const { laneDir, certs, lane, receipts } = options;
  const monitor = lifecycleMonitor();
  const proxies = [];
  try {
    for (const [name, targetHost] of [
      ['api2', 'api2.cursor.sh'],
      ['agentn', 'agentn.global.api5.cursor.sh'],
    ]) {
      const proxy = createCaptureProxy({
        port: 0,
        targetHost,
        cert: fs.readFileSync(certs.leafCrt),
        key: fs.readFileSync(certs.leafKey),
        captureDir: path.join(laneDir, name),
        captureExact: true,
        onLifecycle: name === 'agentn' ? (event) => monitor.record(event) : undefined,
        maxReqFrameBins: 0,
        maxResFrameBins: 0,
        log: (...values) =>
          fs.appendFileSync(path.join(laneDir, `${name}.log`), `${values.join(' ')}\n`, {
            mode: 0o600,
          }),
      });
      proxies.push({ proxy, name });
      const address = await bounded(proxy.listen(), 5000, 'proxy_listen_timeout', options.signal);
      options[name === 'api2' ? 'api' : 'agent'] = `https://127.0.0.1:${address.port}`;
    }
    const result = await (lane === 'native' ? runPreparedNative : runBridge)({
      ...options,
      monitor,
    });
    result.lifecycle = monitor.entries;
    return result;
  } finally {
    for (const { proxy, name } of proxies.reverse()) {
      const receipt = { role: `${lane}-${name}-proxy`, ok: false };
      receipts.push(receipt);
      try {
        await bounded(proxy.close(), 3000, 'proxy_close_timeout');
        receipt.ok = true;
      } catch {
        receipt.error = 'proxy_close_timeout';
      }
    }
  }
}
