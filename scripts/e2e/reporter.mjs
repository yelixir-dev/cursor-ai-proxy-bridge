/* global performance */

export async function runScenario(results, name, run) {
  const started = performance.now();
  try {
    const detail = await run();
    results.push({
      name,
      result: 'PASS',
      latencyMs: performance.now() - started,
      detail: detail || '',
    });
  } catch (error) {
    results.push({
      name,
      result: 'FAIL',
      latencyMs: performance.now() - started,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

export function formatTable(results, backend) {
  const nameWidth = Math.max('Scenario'.length, ...results.map((row) => row.name.length));
  const lines = [
    `\nBackend: ${backend}`,
    `${'Scenario'.padEnd(nameWidth)} | Result | Latency`,
    `${'-'.repeat(nameWidth)}-+--------+----------`,
  ];
  for (const row of results) {
    lines.push(
      `${row.name.padEnd(nameWidth)} | ${row.result.padEnd(6)} | ${(row.latencyMs / 1000).toFixed(2).padStart(7)}s`,
    );
    if (row.detail) lines.push(`${' '.repeat(nameWidth)} |        | ${row.detail}`);
  }
  return lines.join('\n');
}
