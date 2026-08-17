import { describe, expect, it } from 'vitest';
import {
  filterToolCallsToAllowed,
  parseToolCallsFromText,
  toolDelegationPromptSuffix,
} from '../src/backend/tool-call-parse.js';
import type { Tool } from '../src/backend/types.js';

const terminalTool: Tool = {
  type: 'function',
  function: {
    name: 'terminal',
    description: 'Run a shell command',
    parameters: { type: 'object', properties: { command: { type: 'string' } } },
  },
};

const readFileTool: Tool = {
  type: 'function',
  function: {
    name: 'read_file',
    description: 'Read a file',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
  },
};

describe('tool-call parsing', () => {
  it('parses [TOOL_CALLS: ...] blocks from Cursor text output', () => {
    const parsed = parseToolCallsFromText(
      'I will delegate.\n[TOOL_CALLS: [{"function":{"name":"terminal","arguments":{"command":"printf ok"}}}]]\n',
    );

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.function.name).toBe('terminal');
    expect(JSON.parse(parsed[0]?.function.arguments ?? '{}')).toEqual({ command: 'printf ok' });
  });

  it('generates unique UUID-based ids for marker calls without ids', () => {
    const parsed = parseToolCallsFromText(
      '[TOOL_CALLS: [{"function":{"name":"terminal","arguments":{}}},{"function":{"name":"terminal","arguments":{}}}]]',
    );

    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.id).toMatch(/^call_bridge_[0-9a-f-]{36}$/);
    expect(parsed[1]?.id).toMatch(/^call_bridge_[0-9a-f-]{36}$/);
    expect(parsed[0]?.id).not.toBe(parsed[1]?.id);
  });

  it('preserves a client-declared custom name ending in ToolCall', () => {
    const parsed = parseToolCallsFromText(
      '[TOOL_CALLS: [{"function":{"name":"myToolCall","arguments":{"value":"kept"}}}]]',
    );
    const allowed = filterToolCallsToAllowed(parsed, [
      {
        type: 'function',
        function: { name: 'myToolCall', parameters: { type: 'object' } },
      },
    ]);

    expect(allowed).toHaveLength(1);
    expect(allowed[0]?.function.name).toBe('myToolCall');
    expect(JSON.parse(allowed[0]?.function.arguments ?? '{}')).toEqual({ value: 'kept' });
  });

  it('filters parsed tool calls to tools allowed by the OpenAI request', () => {
    const allowed = filterToolCallsToAllowed(
      [
        {
          id: 'call_a',
          type: 'function',
          function: { name: 'terminal', arguments: '{"command":"date"}' },
        },
        {
          id: 'call_b',
          type: 'function',
          function: { name: 'write_file', arguments: '{"path":"/tmp/x"}' },
        },
      ],
      [terminalTool],
    );

    expect(allowed).toHaveLength(1);
    expect(allowed[0]?.function.name).toBe('terminal');
  });

  it('generates an explicit [TOOL_CALLS] delegation suffix for Cursor text fallback', () => {
    const suffix = toolDelegationPromptSuffix([terminalTool, readFileTool]);

    expect(suffix).toContain('[TOOL_CALLS:');
    expect(suffix).toContain('terminal');
    expect(suffix).toContain('read_file');
    expect(suffix).toContain('Do not execute the tool yourself');
  });
});
