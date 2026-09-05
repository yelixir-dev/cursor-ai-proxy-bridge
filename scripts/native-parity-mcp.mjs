#!/usr/bin/env node
/* global process, console, structuredClone */
import fs from 'node:fs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const objectSchema = (properties, required) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const definitions = {
  echo_value: {
    name: 'echo_value',
    description: 'Return the supplied value unchanged.',
    inputSchema: objectSchema({ value: { type: 'string' } }, ['value']),
  },
  lookup_code: {
    name: 'lookup_code',
    description: 'Look up ALPHA and return the opaque code needed by finish_code.',
    inputSchema: objectSchema({ key: { type: 'string', enum: ['ALPHA'] } }, ['key']),
  },
  finish_code: {
    name: 'finish_code',
    description: 'Consume exactly the opaque code returned by lookup_code and return DONE.',
    inputSchema: objectSchema({ code: { type: 'string' } }, ['code']),
  },
};
export function toolsFor(caseId) {
  return structuredClone(
    caseId === 'parallel'
      ? [definitions.echo_value]
      : caseId === 'sequential'
        ? [definitions.lookup_code, definitions.finish_code]
        : [],
  );
}
export function createToolState(caseId, nextCode) {
  return { caseId, nextCode, calls: [] };
}
export function executeTool(state, name, args) {
  const definition = toolsFor(state.caseId).find((tool) => tool.name === name);
  const key = definition?.inputSchema.required[0];
  if (
    !definition ||
    !args ||
    typeof args !== 'object' ||
    Array.isArray(args) ||
    Object.keys(args).length !== 1 ||
    typeof args[key] !== 'string'
  )
    throw new Error('invalid_tool_arguments');
  let text;
  if (name === 'echo_value') text = args.value;
  else if (name === 'lookup_code') {
    if (args.key !== 'ALPHA' || state.calls.length !== 0) throw new Error('invalid_lookup_order');
    text = state.nextCode;
  } else {
    if (
      state.calls.length !== 1 ||
      state.calls[0].name !== 'lookup_code' ||
      args.code !== state.nextCode
    )
      throw new Error('invalid_dependent_argument');
    text = 'DONE';
  }
  state.calls.push({ name, args: structuredClone(args), result: text });
  return { content: [{ type: 'text', text }] };
}

export async function serveMcp(input = process.stdin, output = process.stdout, env = process.env) {
  const state = createToolState(env.NATIVE_PARITY_CASE, env.NATIVE_PARITY_NEXT_CODE);
  const audit = (record) => {
    if (env.NATIVE_PARITY_MCP_AUDIT)
      fs.appendFileSync(env.NATIVE_PARITY_MCP_AUDIT, `${JSON.stringify(record)}\n`, {
        mode: 0o600,
      });
  };
  audit({ event: 'started', pid: process.pid });
  const lines = createInterface({ input, crlfDelay: Infinity });
  const terminate = () => {
    lines.close();
    input.destroy();
  };
  if (input === process.stdin) process.on('SIGTERM', terminate);
  try {
    for await (const line of lines) {
      let request;
      try {
        request = JSON.parse(line);
      } catch {
        throw new Error('malformed_mcp_json');
      }
      if (request.id === undefined) continue;
      let result;
      let error;
      try {
        switch (request.method) {
          case 'initialize':
            result = {
              protocolVersion: request.params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: 'native-parity', version: '1' },
            };
            break;
          case 'ping':
            result = {};
            break;
          case 'tools/list':
            result = { tools: toolsFor(state.caseId) };
            break;
          case 'tools/call': {
            result = executeTool(state, request.params.name, request.params.arguments);
            audit({ event: 'call', ...state.calls.at(-1) });
            break;
          }
          default:
            error = { code: -32601, message: 'Method not found' };
        }
      } catch {
        audit({ event: 'tool_error' });
        error = { code: -32602, message: 'Invalid tool invocation' };
      }
      output.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: request.id, ...(error ? { error } : { result }) })}\n`,
      );
    }
  } finally {
    if (input === process.stdin) process.off('SIGTERM', terminate);
    lines.close();
    audit({ event: 'closed', pid: process.pid });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  serveMcp().catch(() => {
    console.error('native-parity MCP failed');
    process.exitCode = 1;
  });
}
