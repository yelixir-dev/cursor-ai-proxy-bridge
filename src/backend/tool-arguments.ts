import AjvModule from 'ajv';
import type { ErrorObject, ValidateFunction } from 'ajv';
import type { Tool, ToolCall } from './types.js';

const ajv = new AjvModule.default({
  allErrors: false,
  coerceTypes: false,
  removeAdditional: false,
  strict: false,
  useDefaults: false,
});
const validators = new WeakMap<Record<string, unknown>, ValidateFunction>();

export interface ToolArgumentValidationFailure {
  toolName: string;
  message: string;
}

export class ToolArgumentValidationError extends Error {
  constructor(readonly failure: ToolArgumentValidationFailure) {
    super(`Tool "${failure.toolName}" arguments failed schema validation: ${failure.message}`);
    this.name = 'ToolArgumentValidationError';
  }
}

function validationMessage(error: ErrorObject | null | undefined): string {
  if (!error) return 'arguments do not match the declared parameters schema';
  const location = error.instancePath ? `arguments${error.instancePath}` : 'arguments';
  return `${location} ${error.message ?? 'do not match the declared parameters schema'}`;
}

function validatorFor(parameters: Record<string, unknown>): ValidateFunction {
  const existing = validators.get(parameters);
  if (existing) return existing;
  const validator = ajv.compile(parameters);
  validators.set(parameters, validator);
  return validator;
}

export function validateToolCallArguments(
  toolCalls: readonly ToolCall[],
  tools: readonly Tool[] | undefined,
): ToolArgumentValidationFailure | undefined {
  const toolsByName = new Map((tools ?? []).map((tool) => [tool.function.name, tool]));

  for (const call of toolCalls) {
    const tool = toolsByName.get(call.function.name);
    if (!tool) continue;

    let args: unknown;
    try {
      args = JSON.parse(call.function.arguments);
    } catch {
      return { toolName: call.function.name, message: 'arguments are not valid JSON' };
    }

    const parameters = tool.function.parameters ?? { type: 'object' };
    let validator: ValidateFunction;
    try {
      validator = validatorFor(parameters);
    } catch (error) {
      return {
        toolName: call.function.name,
        message: `declared parameters schema is invalid: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (!validator(args)) {
      return {
        toolName: call.function.name,
        message: validationMessage(validator.errors?.[0]),
      };
    }
  }

  return undefined;
}
