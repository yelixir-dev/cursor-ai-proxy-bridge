import { CANONICAL_CASE_IDS } from './cases.js';
import type { BenchmarkProfile } from './schedule.js';
import type { CanonicalCaseId } from './types.js';

export const DEFAULT_BENCHMARK_SEED = 20260818;
export const DEFAULT_BENCHMARK_OUTPUT =
  '.omo/evidence/cursor-composer-parity-benchmark/composer-parity.json';
const PROFILES: readonly BenchmarkProfile[] = ['smoke', 'ci', 'strict'];
const VALUE_FLAGS = new Set(['--profile', '--seed', '--case', '--output']);

function isProfile(value: string): value is BenchmarkProfile {
  return PROFILES.some((profile) => profile === value);
}

function isCanonicalCaseId(value: string): value is CanonicalCaseId {
  return CANONICAL_CASE_IDS.some((caseId) => caseId === value);
}

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

export interface BenchmarkCliOptions {
  profile: BenchmarkProfile;
  seed: number;
  caseIds: CanonicalCaseId[] | null;
  output: string;
  dryRun: boolean;
}

export function parseBenchmarkArgs(argv: readonly string[]): BenchmarkCliOptions {
  let profile: BenchmarkProfile | undefined;
  let seed: number | undefined;
  let output: string | undefined;
  let dryRun = false;
  const caseIds: CanonicalCaseId[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) throw new CliUsageError(`unknown argument: ${flag}`);
    const value = argv[index + 1];
    if (value === undefined) throw new CliUsageError(`${flag} requires a value`);
    index += 1;
    if (flag === '--profile') {
      if (!isProfile(value))
        throw new CliUsageError(`--profile must be one of ${PROFILES.join('|')}`);
      profile = value;
    } else if (flag === '--seed') {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0)
        throw new CliUsageError('--seed must be a non-negative integer');
      seed = parsed;
    } else if (flag === '--case') {
      if (!isCanonicalCaseId(value))
        throw new CliUsageError(
          `--case must be a canonical case id: ${CANONICAL_CASE_IDS.join(', ')}`,
        );
      const caseId = value;
      if (caseIds.includes(caseId)) throw new CliUsageError(`--case repeated: ${caseId}`);
      caseIds.push(caseId);
    } else if (value.trim() === '') {
      throw new CliUsageError('--output must not be empty');
    } else {
      output = value;
    }
  }
  return {
    profile: profile ?? 'smoke',
    seed: seed ?? DEFAULT_BENCHMARK_SEED,
    caseIds: caseIds.length > 0 ? caseIds : null,
    output: output ?? DEFAULT_BENCHMARK_OUTPUT,
    dryRun,
  };
}
