#!/usr/bin/env node
import { loadConfig } from './config.js';
import { createMockBackend } from './backend/mock.js';
import { createCursorCliBackend } from './backend/cursor-cli.js';
import { buildServer } from './server.js';

async function main() {
  const config = loadConfig();
  const backend =
    config.backend === 'cursor-cli' ? createCursorCliBackend(config) : createMockBackend();
  const server = await buildServer({ config, backend });

  const close = async () => {
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
