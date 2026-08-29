import { withContextWindow, withCursorModelContext } from '../../model-context.js';
import type { BridgeModel } from '../types.js';
import { modelCredentialRequirement } from './credential-plan.js';

/**
 * Unified model surface: one model id per family (+ `-fast` / `-thinking`
 * model splits), with reasoning strength as a `reasoning_effort` request
 * field instead of Cursor's per-variant slugs.
 *
 * Legacy slugs (e.g. `claude-opus-5-thinking-max-fast`) stay valid on the
 * request path; only the advertised list is unified.
 */

const EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
type Effort = (typeof EFFORTS)[number];

const EFFORT_PATTERN = EFFORTS.join('|');
const FAMILY_RULES: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly unified: (family: string, thinking: boolean, fast: boolean) => string;
}> = [
  {
    // claude-opus-5-thinking-max-fast → opus-5-thinking-fast
    pattern: new RegExp(
      `^claude-((?:fable|opus|sonnet)-5)(?:-(thinking))?-(${EFFORT_PATTERN})(?:-(fast))?$`,
    ),
    unified: (family, thinking, fast) =>
      `${family}${thinking ? '-thinking' : ''}${fast ? '-fast' : ''}`,
  },
  {
    // gpt-5.6-sol-xhigh-fast → gpt-5.6-sol-fast
    pattern: new RegExp(`^(gpt-5\\.6-(?:sol|terra|luna))-(${EFFORT_PATTERN})(?:-(fast))?$`),
    unified: (family, _thinking, fast) => `${family}${fast ? '-fast' : ''}`,
  },
  {
    // cursor-grok-4.6-high-fast → grok-4.6-fast
    pattern: new RegExp(`^cursor-(grok-4\\.6)-(${EFFORT_PATTERN})(?:-(fast))?$`),
    unified: (family, _thinking, fast) => `${family}${fast ? '-fast' : ''}`,
  },
  {
    // kimi-k3-max → kimi-k3, glm-5.2-high → glm-5.2
    pattern: new RegExp(`^((?:kimi-k3|glm-5\\.2))-(${EFFORT_PATTERN})$`),
    unified: (family) => family,
  },
];

function splitSlug(
  slug: string,
): { family: string; thinking: boolean; fast: boolean; effort: Effort } | undefined {
  for (const rule of FAMILY_RULES) {
    const match = rule.pattern.exec(slug);
    if (!match) continue;
    const groups = match.slice(1);
    const effort = groups.find((group): group is Effort =>
      (EFFORTS as readonly string[]).includes(group ?? ''),
    );
    if (!effort) continue;
    return {
      family: match[1] ?? '',
      thinking: groups.includes('thinking'),
      fast: groups.includes('fast'),
      effort,
    };
  }
  return undefined;
}

/** The advertised unified id for a legacy variant slug, or null when it is not one. */
export function unifiedFromSlug(slug: string): string | undefined {
  for (const rule of FAMILY_RULES) {
    const match = rule.pattern.exec(slug);
    if (!match) continue;
    const thinking = match[2] === 'thinking';
    const fast = match[3] === 'fast' || match[4] === 'fast';
    return rule.unified(match[1] ?? '', thinking, fast);
  }
  return undefined;
}

const MEDIUM_LESS_FAMILIES = new Set(['kimi-k3', 'glm-5.2']);

/**
 * Collapse the live slug list into the advertised unified model list.
 *
 * `liveContextWindow` reports the window of the variant this bridge actually
 * selects for an advertised id. It wins over the curated family default so a
 * 1M max-mode variant is never advertised as its smaller non-max sibling.
 */
export function unifiedModelList(
  models: readonly BridgeModel[],
  liveContextWindow?: (unifiedId: string) => number | undefined,
): BridgeModel[] {
  const seen = new Set<string>();
  const unified: BridgeModel[] = [];
  for (const model of models) {
    const id = unifiedFromSlug(model.id) ?? model.id;
    if (seen.has(id)) continue;
    seen.add(id);
    const credentialRequirement = modelCredentialRequirement(id);
    const advertised = {
      ...model,
      id,
      ...(credentialRequirement === undefined
        ? {}
        : { credential_requirement: credentialRequirement }),
    };
    const live = liveContextWindow?.(id);
    unified.push(
      live === undefined ? withCursorModelContext(advertised) : withContextWindow(advertised, live),
    );
  }
  return unified;
}

/**
 * Resolve a request model id to the live variant slug. Legacy slugs resolve
 * to themselves. Unified ids pick the slug matching `reasoning_effort`;
 * default effort is medium (families without medium: high).
 */
export function resolveVariantSlug(
  model: string,
  effort: string | undefined,
  availableSlugs: Iterable<string>,
): string | undefined {
  const candidates: Array<{ slug: string; effort: Effort }> = [];
  for (const slug of availableSlugs) {
    if (slug === model) return slug;
    const parts = splitSlug(slug);
    if (!parts) continue;
    if (unifiedFromSlug(slug) === model) candidates.push({ slug, effort: parts.effort });
  }
  if (candidates.length === 0) return undefined;
  const efforts = new Set(candidates.map((candidate) => candidate.effort));
  const wanted =
    effort && efforts.has(effort as Effort)
      ? (effort as Effort)
      : MEDIUM_LESS_FAMILIES.has(model)
        ? 'high'
        : efforts.has('medium')
          ? 'medium'
          : 'high';
  return (candidates.find((candidate) => candidate.effort === wanted) ?? candidates[0])?.slug;
}
