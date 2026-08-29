import type { RequestedModel, RequestedModelMap } from './requested-models.js';
import { resolveVariantSlug } from './unified-models.js';

/**
 * Cursor publishes each parameterized slug twice: a standard variant and an
 * `isMaxMode` variant that differ only in their `context` parameter. These are
 * the two catalogues those variants land in.
 */
export interface CursorVariantCatalogue {
  /** The variant Cursor's usable-model list binds to each slug. */
  readonly standard: RequestedModelMap;
  /** Every `isMaxMode` variant, whether or not the account defaults to it. */
  readonly max: RequestedModelMap;
}

export interface ModelVariantRequest {
  readonly model: string;
  readonly effort?: string;
  /** Max Mode policy state; `reasoning_effort` never sets this. */
  readonly maxMode: boolean;
}

export interface ResolvedModelVariant {
  readonly slug: string;
  readonly model: RequestedModel;
  readonly isMaxMode: boolean;
}

function lookup(
  models: RequestedModelMap,
  request: ModelVariantRequest,
): ResolvedModelVariant | undefined {
  const direct = models.get(request.model);
  if (direct) return { slug: request.model, model: direct, isMaxMode: direct.maxMode };
  const slug = resolveVariantSlug(request.model, request.effort, models.keys());
  if (!slug) return undefined;
  const resolved = models.get(slug);
  return resolved ? { slug, model: resolved, isMaxMode: resolved.maxMode } : undefined;
}

/**
 * Resolve an advertised id to the variant the run will use. With Max Mode on,
 * the max catalogue is preferred and the standard catalogue still answers for
 * families Cursor publishes without a max variant.
 */
export function resolveModelVariant(
  models: CursorVariantCatalogue,
  request: ModelVariantRequest,
): ResolvedModelVariant | undefined {
  const catalogues = request.maxMode ? [models.max, models.standard] : [models.standard];
  for (const catalogue of catalogues) {
    const resolved = lookup(catalogue, request);
    if (resolved) return resolved;
  }
  return undefined;
}
