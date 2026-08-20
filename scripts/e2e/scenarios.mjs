import { coreScenarios } from './scenarios-core.mjs';
import { dependentScenarios } from './scenarios-dependent.mjs';
import { historyScenarios } from './scenarios-history.mjs';
import { streamingScenarios } from './scenarios-streaming.mjs';
import { toolChoiceScenarios } from './scenarios-tool-choice.mjs';
import { validationScenarios } from './scenarios-validation.mjs';

export const SCENARIO_IDS = [
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
];

export function createScenarios(context) {
  return [
    ...coreScenarios(context),
    ...historyScenarios(context),
    ...dependentScenarios(context),
    ...toolChoiceScenarios(context),
    ...validationScenarios(context),
    ...streamingScenarios(context),
  ];
}
