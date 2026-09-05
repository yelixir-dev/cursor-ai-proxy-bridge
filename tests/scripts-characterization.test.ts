import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const EXPECTED_SCENARIO_IDS = [
  'health 200',
  'missing auth 401',
  'basic chat sentinel echo',
  'auto single tool call',
  'auto two parallel tool calls',
  'reserved Shell name returns three parallel calls',
  'sequential two-round tool conversation',
  'Composer defaults to ten single-call rounds',
  'dependent 3-2-2 multi-tool conversation',
  'auto tool-result-only follow-up continues the loop',
  'forced function uses model args',
  'required tool choice invokes model',
  'tool_choice none suppresses calls',
  'parallel_tool_calls false caps calls',
  '400 unknown forced name',
  '400 required without tools',
  '400 duplicate tool names',
  '400 orphan tool_call_id',
  '400 duplicate tool call ids',
  '400 malformed JSON envelope',
  'streaming incremental TTFB and usage',
  'tool-declared text streams before completion',
  'streaming indexed tool calls',
  'stream abort reaps cursor-agent',
] as const;

describe('extracted script contracts', () => {
  it('registers the exact machine-consumed E2E scenario IDs in execution order', async () => {
    // Given: the extracted scenario registry.
    const source = await readFile('scripts/e2e/scenarios.mjs', 'utf8');

    // When: the canonical registration identifiers are parsed.
    const ids = [...source.matchAll(/^ {2}'([^']+)',?$/gm)].map((match) => match[1] ?? '');

    // Then: all 24 identifiers retain their original order.
    expect(ids).toEqual(EXPECTED_SCENARIO_IDS);
    expect(ids).toHaveLength(24);
  });

  it('pins server argv and machine output parsing tokens', async () => {
    // Given: the extracted command, parser, and reporter modules.
    const [config, http, reporter, server, streaming, entrypoint] = await Promise.all([
      readFile('scripts/e2e/config.mjs', 'utf8'),
      readFile('scripts/e2e/http.mjs', 'utf8'),
      readFile('scripts/e2e/reporter.mjs', 'utf8'),
      readFile('scripts/e2e/server.mjs', 'utf8'),
      readFile('scripts/e2e/scenarios-streaming.mjs', 'utf8'),
      readFile('scripts/e2e-smoke.mjs', 'utf8'),
    ]);

    // When: command and output boundaries are inspected.
    const serverArgv = config.match(/SERVER_ARGV = \[(?<argv>[^\]]+)\]/)?.groups?.argv;

    // Then: the child command and report/parser tokens retain their contracts.
    expect(serverArgv).toBe("'dist/index.js'");
    expect(http).toContain("frame.startsWith('data: {')");
    expect(http).toContain("text.trim().endsWith('data: [DONE]')");
    expect(http).toContain('body?.choices?.[0]?.message');
    expect(reporter).toContain("'Scenario'.padEnd(nameWidth)");
    expect(reporter).toContain("lines.join('\\n')");
    expect(config).toContain('REQUEST_TIMEOUT_MS = 180_000');
    expect(server).toContain("deadline(30_000, 'server listen deadline exceeded')");
    expect(server).toContain("deadline(10_000, 'server shutdown deadline exceeded')");
    expect(streaming).toContain('signal: AbortSignal.timeout(10_000)');
    expect(entrypoint.indexOf('await stopServer')).toBeLessThan(
      entrypoint.lastIndexOf('formatTable'),
    );
    expect(entrypoint.lastIndexOf('traceProvenance.ingest')).toBeLessThan(
      entrypoint.indexOf('.finish'),
    );
  });

  it('pins the protobuf artifact shape and output destination', async () => {
    // Given: the extracted protobuf contract, model, and entrypoint modules.
    const [contracts, descriptors, entrypoint] = await Promise.all([
      readFile('scripts/protos/contracts.mjs', 'utf8'),
      readFile('scripts/protos/descriptors.mjs', 'utf8'),
      readFile('scripts/extract-protos.mjs', 'utf8'),
    ]);

    // When: the machine-consumed output contract is inspected.
    const rootBlock = contracts.match(/ROOT_TYPES = \[(?<roots>[\s\S]*?)\];/)?.groups?.roots ?? '';
    const rootTypeCount = rootBlock.match(/^ {2}'(?:aiserver|agent)\.v1\.[^']+',?$/gm)?.length;

    // Then: roots, format fields, and destination remain stable through extraction.
    expect(rootTypeCount).toBe(16);
    expect(descriptors).toContain('format: 1');
    expect(descriptors).toContain('bundleVersion');
    expect(descriptors).toMatch(/clientVersion: `cli-\$\{bundleVersion\}`/);
    expect(entrypoint).toContain(
      "path.join(repoRoot, 'src', 'backend', 'cursor-api', 'proto-descriptors.json')",
    );
    expect(entrypoint).toContain('serializeDescriptorOutput(output)');
  });
});
