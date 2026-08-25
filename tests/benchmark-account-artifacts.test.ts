import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compareBenchmarkAccounts } from '../src/benchmark/account-comparability.js';
import { AccountComparabilitySchema } from '../src/benchmark/account-schema.js';
import { writeBenchmarkArtifacts } from '../src/benchmark/artifacts.js';
import { createCanonicalCases } from '../src/benchmark/cases.js';
import { renderMarkdownReport } from '../src/benchmark/report.js';
import { runBenchmark } from '../src/benchmark/runner.js';
import type { LaneTrialSample } from '../src/benchmark/trial-record.js';

const roots: string[] = [];
const jwt = (subject: string) =>
  `e30.${Buffer.from(JSON.stringify({ sub: subject })).toString('base64url')}.signature`;
const emptyChild = () => ({ diagnostics: '', exits: [], session: null });

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('benchmark account evidence propagation', () => {
  it('threads measured status through schema, Markdown, and versions companion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'benchmark-account-test-'));
    roots.push(root);
    const testCase = createCanonicalCases().find(
      (candidate) => candidate.id === 'text_sentinel_stream',
    );
    if (testCase === undefined) throw new Error('missing text sentinel benchmark case');
    const comparison = await compareBenchmarkAccounts(jwt('same'), {
      CURSOR_AUTH_TOKEN: jwt('same'),
    });
    const result = await runBenchmark(
      {
        seed: 20260818,
        profile: 'smoke',
        cases: [testCase],
        dryRun: false,
        companionFiles: [
          { kind: 'bridge_trace', path: 'result.bridge-trace.jsonl' },
          { kind: 'versions_environment', path: 'result.versions-environment.json' },
          { kind: 'command_exit', path: 'result.command-exit.json' },
          { kind: 'cleanup', path: 'result.cleanup.json' },
        ],
      },
      {
        preflight: async () => ({
          ok: true,
          activeBackend: 'cursor-api',
          bridgeVersion: 'test',
          accountComparability: comparison,
        }),
        executeTrial: async (request): Promise<LaneTrialSample> => ({
          rawEvents: [
            { type: 'agent_start', atMs: 0 },
            { type: 'text_delta', delta: request.sentinel, atMs: 1 },
            { type: 'agent_end', atMs: 2 },
          ],
          durationMs: 2,
          upstreamRuns: 1,
          failureClass: null,
          promptHash: null,
          httpStatus: null,
          isolatedSentinels: null,
          traceJoin:
            request.lane === 'yorha'
              ? {
                  sequence_start: request.pairIndex * 2 + 1,
                  sequence_end: request.pairIndex * 2 + 1,
                  request_ids: [`req-${request.pairIndex}`],
                  record_count: 1,
                  attributed_run_count: 1,
                  synchronized: true,
                }
              : null,
          childReport: emptyChild(),
        }),
      },
    );
    expect(result.evidence.companions.account_comparability.status).toBe('matched');
    expect(() =>
      AccountComparabilitySchema.parse(result.evidence.companions.account_comparability),
    ).not.toThrow();
    const markdown = renderMarkdownReport({
      evidence: result.evidence,
      schedule: result.schedule,
      isMeasured: () => true,
    });
    expect(markdown).toContain('| account_status | matched |');
    expect(markdown).toContain('| identity_status | unverified_claim_match |');
    expect(markdown).toContain('| cryptographic_identity_proven | false |');
    const runtime = {
      traceRecords: result.evidence.trials
        .filter((trial) => trial.lane === 'yorha')
        .flatMap((trial) => {
          const sequence = trial.trace_join?.sequence_start;
          const requestId = trial.trace_join?.request_ids[0];
          if (sequence === null || sequence === undefined || requestId === undefined) return [];
          return [
            {
              sequence,
              request_id: requestId,
              credential_slot_id: null,
              backend: 'cursor-api' as const,
              model: 'composer-2.5',
              upstream_run_count: 1,
              stage: 'run_open' as const,
              offset_ms: 1,
            },
          ];
        }),
      bridgeCleanup: null,
      exitCode: 0,
      tempRoot: root,
    };
    Reflect.set(runtime, 'comparator', {
      executable: {
        sanitizedPath: '$PROJECT/.omo/comparators/mismatch/omo',
        provenance: 'task_owned_absolute',
      },
      inspection: {
        observedVersionString: 'omo 5.0.0-0.beta.10 (engine: senpi 2026.8.18)',
        observedOmoVersion: '5.0.0-0.beta.10',
        observedSenpiVersion: '2026.8.18',
        modelObserved: true,
      },
    });
    await writeBenchmarkArtifacts(join(root, 'result.json'), result, runtime);
    const versions = JSON.parse(
      await readFile(join(root, 'result.versions-environment.json'), 'utf8'),
    );
    expect(versions).toMatchObject({
      omo_version: '5.0.0-0.beta.10',
      senpi_engine_version: '2026.8.18',
      observed_version_string: 'omo 5.0.0-0.beta.10 (engine: senpi 2026.8.18)',
      pinned_omo_version: '5.0.0-0.beta.9',
      pinned_senpi_engine_version: '2026.8.17',
      comparator: {
        resolved_path: '$PROJECT/.omo/comparators/mismatch/omo',
        path_provenance: 'task_owned_absolute',
        resolved_path_is_absolute: true,
        model_id: 'composer-2.5',
        model_observed: true,
      },
      shared_stable_identity_proven: false,
      account_comparability: comparison,
    });
  });
});
