#!/usr/bin/env node
import { loadConfig } from './config.js';
import { createMockBackend } from './backend/mock.js';
import { createConfiguredBackend } from './backend/auto.js';
import { buildServer } from './server.js';

async function main() {
  const config = loadConfig();
  const backend =
    config.backend === 'mock' ? createMockBackend() : await createConfiguredBackend(config);
  const server = await buildServer({ config, backend });

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await backend.shutdown?.();
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void close());
  process.on('SIGTERM', () => void close());

  await server.listen({ host: config.host, port: config.port });
  console.log(`cursor-ai-bridge listening on http://${config.host}:${config.port}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
