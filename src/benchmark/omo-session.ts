import type { OmoTrialResult } from './omo-process-types.js';
import { OmoProcessError } from './omo-process-types.js';
import { summarizeSessionDirectory } from './session-summary.js';

export async function attachSessionSummary(
  result: OmoTrialResult,
  sessionDir: string,
): Promise<void> {
  try {
    result.session = await summarizeSessionDirectory(sessionDir);
  } catch (cause) {
    const error = new OmoProcessError(
      'evidence_io_failure',
      'failed to collect OMO session evidence',
      { cause },
    );
    error.details = result;
    throw error;
  }
}
