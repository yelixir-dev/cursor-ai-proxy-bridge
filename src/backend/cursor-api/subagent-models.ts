import type { RequestedModel } from './requested-models.js';

export type SelectedSubagentModel = Pick<RequestedModel, 'modelId' | 'parameters'>;

interface AvailableSubagentModel {
  readonly name?: string;
  readonly supportsAgent?: boolean;
  readonly defaultOn?: boolean;
  readonly variants?: readonly {
    readonly isDefaultNonMaxConfig?: boolean;
    readonly isDefaultMaxConfig?: boolean;
    readonly parameterValues?: readonly { readonly id?: string; readonly value?: string }[];
  }[];
}

/** Native ModelManager defaults, independent of the public model visibility policy. */
export function mapSelectedSubagentModels(available: {
  readonly models?: readonly AvailableSubagentModel[];
}): readonly SelectedSubagentModel[] {
  return Object.freeze(
    (available.models ?? [])
      .filter((model) => model.supportsAgent && model.defaultOn)
      .map((model) => {
        const variants = model.variants ?? [];
        const variant =
          variants.find((variant) => variant.isDefaultNonMaxConfig) ??
          variants.find((variant) => variant.isDefaultMaxConfig) ??
          variants[0];
        return Object.freeze({
          modelId: model.name ?? '',
          parameters: Object.freeze(
            (variant?.parameterValues ?? []).map((parameter) =>
              Object.freeze({ id: parameter.id ?? '', value: parameter.value ?? '' }),
            ),
          ),
        });
      }),
  );
}
