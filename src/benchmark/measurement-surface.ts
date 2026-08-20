import { owningLayerFor } from './failure-owners.js';
import type { BenchmarkCase, FailureClass, OwningLayer, ToolChoiceMode } from './types.js';

export const PAIRED_TOOL_CHOICE_SURFACE = 'prompt_only' as const;
export type PairedToolChoiceSurface = typeof PAIRED_TOOL_CHOICE_SURFACE;

export interface PairedToolChoiceMeasurement {
  readonly case_id: BenchmarkCase['id'];
  readonly requested_tool_choice: ToolChoiceMode;
  readonly transmits_openai_tool_choice: false;
  readonly surface: PairedToolChoiceSurface;
}

/**
 * The paired OMO comparator registers the canonical tools on both lanes and has
 * no tool-choice option to forward, so `request.toolChoice` never reaches the
 * OpenAI boundary: the paired surface for a non-auto choice is the prompt only.
 * The OpenAI `tool_choice` contract itself is locked at the OpenAI boundary in
 * `scripts/e2e-smoke.mjs` and the server/cursor-api unit tests.
 */
export function pairedToolChoiceMeasurement(
  testCase: BenchmarkCase,
): PairedToolChoiceMeasurement | null {
  const requested = testCase.request.toolChoice;
  if (requested === 'auto') return null;
  return {
    case_id: testCase.id,
    requested_tool_choice: requested,
    transmits_openai_tool_choice: false,
    surface: PAIRED_TOOL_CHOICE_SURFACE,
  };
}

/**
 * True only when a paired trial failed in a way that presumes the OpenAI
 * `tool_choice: none` field was transmitted. Because the field never leaves the
 * harness, such a spontaneous tool is an invalid paired measurement (model
 * variance), not a bridge scheduling defect.
 */
export function isInvalidPairedToolChoiceMeasurement(
  testCase: BenchmarkCase,
  failureClass: FailureClass | null,
): boolean {
  return testCase.request.toolChoice === 'none' && failureClass === 'unexpected_tool';
}

export function trialOwningLayer(testCase: BenchmarkCase, failureClass: FailureClass): OwningLayer {
  return isInvalidPairedToolChoiceMeasurement(testCase, failureClass)
    ? 'model_variance'
    : owningLayerFor(failureClass);
}

/**
 * Correctness gate id for a paired case. The unsent-field `none` case is scoped
 * to the prompt-only surface so the gate cannot be read as the OpenAI
 * `tool_choice: none` contract.
 */
export function pairedCorrectnessGateId(testCase: BenchmarkCase): string {
  const base = `correctness.${testCase.id.toLowerCase()}`;
  return testCase.request.toolChoice === 'none' ? `${base}_prompt_only` : base;
}
