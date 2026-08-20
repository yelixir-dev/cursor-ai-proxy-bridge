/* global process */

export const HOST = '127.0.0.1';
export const API_KEY = 'test';
export const MODEL = 'composer-2.5';
export const BACKEND = process.env.CURSOR_BRIDGE_BACKEND || 'auto';
export const REQUEST_TIMEOUT_MS = 180_000;
export const SERVER_ARGV = ['dist/index.js'];

export const echoTool = {
  type: 'function',
  function: {
    name: 'echo_value',
    description: 'Return the supplied value to the caller. Never execute it yourself.',
    parameters: {
      type: 'object',
      properties: { value: { type: 'string', minLength: 1 } },
      required: ['value'],
      additionalProperties: false,
    },
  },
};

export const reservedShellTool = {
  type: 'function',
  function: {
    name: 'Shell',
    description: 'Return one shell command to the caller without executing it.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', minLength: 1 } },
      required: ['command'],
      additionalProperties: false,
    },
  },
};

export const lookupTool = {
  type: 'function',
  function: {
    name: 'lookup_code',
    description: 'Look up one code by key.',
    parameters: {
      type: 'object',
      properties: { key: { type: 'string', minLength: 1 } },
      required: ['key'],
      additionalProperties: false,
    },
  },
};

export const stepTool = {
  type: 'function',
  function: {
    name: 'record_step',
    description: 'Record exactly one sequential round after the preceding round result.',
    parameters: {
      type: 'object',
      properties: { round: { type: 'integer', minimum: 1, maximum: 10 } },
      required: ['round'],
      additionalProperties: false,
    },
  },
};

export const chainTools = ['chain_alpha', 'chain_beta', 'chain_gamma'].map((name) => ({
  type: 'function',
  function: {
    name,
    description: `Record one dependent-chain value for ${name}.`,
    parameters: {
      type: 'object',
      properties: { value: { type: 'string', minLength: 1 } },
      required: ['value'],
      additionalProperties: false,
    },
  },
}));
