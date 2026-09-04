import { describe, it } from 'vitest';
import {
  accountIsolation,
  activeResumeInvalidation,
  adminChanges,
  adminHolds,
  changedContract,
  contractChanges,
  discoveryRace,
  maxMode,
  unchanged,
} from './support/native-parity-scenarios.js';

describe('native parity through real loopback HTTP and protobuf upstream', () => {
  describe('pinned unchanged continuations', () => {
    for (const first of [false, true])
      for (const next of [false, true]) {
        it(
          'reuses one Run/original credential: ' +
            (first ? 'SSE' : 'JSON') +
            ' -> ' +
            (next ? 'SSE' : 'JSON'),
          () => unchanged(first, next),
          15_000,
        );
      }
  });
  describe('incompatible continuations start fresh without old-stream results', () => {
    for (const change of contractChanges)
      for (const stream of [false, true]) {
        it(
          change + ' (' + (stream ? 'SSE' : 'JSON') + ')',
          () => changedContract(change, stream),
          15_000,
        );
      }
  });
  describe('credential-scoped discovery and invalidation', () => {
    it(
      'selects account endpoints/parameters independently of the advertised listing',
      () => accountIsolation(),
      15_000,
    );
    it('matches Max policy to advertised context and decoded Run', () => maxMode(), 15_000);
    for (const change of adminChanges) {
      it(
        'admin ' + change + ' affects only the appropriate held Runs',
        () => adminHolds(change),
        15_000,
      );
    }
    it(
      'rejects a delayed obsolete discovery response after key replacement',
      () => discoveryRace(),
      15_000,
    );
    it(
      'retains credential cancellation after a held Run resumes under a new HTTP signal',
      () => activeResumeInvalidation(),
      15_000,
    );
  });
});
