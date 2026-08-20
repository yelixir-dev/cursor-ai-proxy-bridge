import type { BridgeModel } from '../types.js';

const MODEL_CREATED = 1_700_000_000;
type Dict = Record<string, unknown>;

export type RequestedModel = {
  readonly modelId: string;
  readonly maxMode: boolean;
  readonly parameters: ReadonlyArray<{ readonly id: string; readonly value: string }>;
  readonly builtInModel: boolean;
  readonly isVariantStringRepresentation: boolean;
};

export type RequestedModelMap = ReadonlyMap<string, RequestedModel>;

export function fallbackRequestedModel(modelId: string): RequestedModel {
  return {
    modelId,
    maxMode: false,
    parameters: [{ id: 'fast', value: 'false' }],
    builtInModel: false,
    isVariantStringRepresentation: false,
  };
}

function dict(value: unknown): Dict | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function records(value: unknown): Dict[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = dict(item);
    return record ? [record] : [];
  });
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

function parameters(value: unknown): Array<{ id: string; value: string }> {
  return records(value).flatMap((parameter) =>
    typeof parameter.id === 'string' && typeof parameter.value === 'string'
      ? [{ id: parameter.id, value: parameter.value }]
      : [],
  );
}

export function mapRequestedModels(
  availableModels: Record<string, unknown>,
  usableModels: Record<string, unknown>,
): Map<string, RequestedModel> {
  const usableMaxMode = new Map<string, boolean>();
  for (const model of records(usableModels.models)) {
    for (const id of [model.modelId, model.displayModelId, ...strings(model.aliases)]) {
      if (typeof id === 'string' && id) usableMaxMode.set(id, Boolean(model.maxMode));
    }
  }

  const requestedModels = new Map<string, RequestedModel>();
  for (const model of records(availableModels.models)) {
    const modelId = model.name || model.serverModelName;
    if (typeof modelId !== 'string' || !modelId) continue;
    for (const variant of records(model.variants)) {
      const maxMode = Boolean(variant.isMaxMode);
      const parameterValues = parameters(variant.parameterValues);
      const aliases = [
        [variant.legacySlug, false],
        [variant.variantStringRepresentation, true],
      ] as const;
      for (const [alias, isVariantStringRepresentation] of aliases) {
        if (typeof alias !== 'string' || !alias) continue;
        const expectedMaxMode = usableMaxMode.get(alias);
        if (expectedMaxMode !== undefined && expectedMaxMode !== maxMode) continue;
        if (expectedMaxMode === undefined && requestedModels.has(alias) && maxMode) continue;
        requestedModels.set(alias, {
          modelId,
          maxMode,
          parameters: parameterValues,
          builtInModel: false,
          isVariantStringRepresentation,
        });
      }
    }
  }
  return requestedModels;
}

export function mapUsableModels(message: Record<string, unknown>): BridgeModel[] {
  const ids = new Set<string>();
  for (const model of records(message.models)) {
    const id = model.modelId || model.displayModelId;
    if (typeof id === 'string' && id) ids.add(id);
    for (const alias of strings(model.aliases)) if (alias) ids.add(alias);
  }
  return [...ids].map((id) => ({
    id,
    object: 'model',
    created: MODEL_CREATED,
    owned_by: 'cursor',
  }));
}
