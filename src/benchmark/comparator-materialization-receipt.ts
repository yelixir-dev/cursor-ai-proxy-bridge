import { relative } from 'node:path';
import {
  PINNED_OMO_VERSION,
  PINNED_SENPI_VERSION,
  type OmoComparatorInspection,
} from './comparator-inspection.js';
import type { CanonicalTaskPath } from './task-owned-path.js';

export const COMPARATOR_PACKAGE_SPEC = `omo-ai@${PINNED_OMO_VERSION}` as const;
export const COMPARATOR_MODEL_ID = 'composer-2.5' as const;

export interface ComparatorMaterializationReceipt {
  readonly package: typeof COMPARATOR_PACKAGE_SPEC;
  readonly install_mode: 'offline';
  readonly prefix: `$PROJECT/${string}`;
  readonly executable: `$PROJECT/${string}`;
  readonly path_provenance: 'verified_canonical_task_path';
  readonly observed_version_string: string | null;
  readonly observed_omo_version: string | null;
  readonly observed_senpi_version: string | null;
  readonly model_id: typeof COMPARATOR_MODEL_ID;
  readonly model_observed: boolean;
  readonly matches_pins: boolean;
}

export type ComparatorMaterializationErrorCode =
  | 'unsafe_task_path'
  | 'inspection_mismatch'
  | 'materialization_failed';

export class ComparatorMaterializationError extends Error {
  readonly name = 'ComparatorMaterializationError';
  readonly code: ComparatorMaterializationErrorCode;
  readonly receipt?: ComparatorMaterializationReceipt;

  constructor(
    message: string,
    options: {
      readonly code: ComparatorMaterializationErrorCode;
      readonly receipt?: ComparatorMaterializationReceipt;
      readonly cause?: Error;
    },
  ) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.code = options.code;
    this.receipt = options.receipt;
  }
}

export function materializationReceipt(
  prefix: CanonicalTaskPath,
  executable: CanonicalTaskPath,
  inspection: OmoComparatorInspection,
): ComparatorMaterializationReceipt {
  const matchesPins =
    inspection.outcome === null &&
    inspection.observedOmoVersion === PINNED_OMO_VERSION &&
    inspection.observedSenpiVersion === PINNED_SENPI_VERSION &&
    inspection.modelObserved;
  return {
    package: COMPARATOR_PACKAGE_SPEC,
    install_mode: 'offline',
    prefix: `$PROJECT/${relative(prefix.projectRoot, prefix.candidate)}`,
    executable: `$PROJECT/${relative(executable.projectRoot, executable.candidate)}`,
    path_provenance: 'verified_canonical_task_path',
    observed_version_string: inspection.observedVersionString,
    observed_omo_version: inspection.observedOmoVersion,
    observed_senpi_version: inspection.observedSenpiVersion,
    model_id: COMPARATOR_MODEL_ID,
    model_observed: inspection.modelObserved,
    matches_pins: matchesPins,
  };
}
