import { describe, expect, it } from 'vitest';
import {
  filterToolCallsToAllowed,
  mapCursorStreamToolCall,
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

  it('maps Cursor stream-json shell tool_call.started events to OpenAI terminal tool_calls', () => {
    const mapped = mapCursorStreamToolCall({
      type: 'tool_call',
      subtype: 'started',
      tool_call: {
        id: 'tc_1',
        name: 'shellToolCall',
        args: { command: 'python3 -c "print(123)"' },
      },
    });

    expect(mapped).toEqual({
      id: 'tc_1',
      type: 'function',
      function: {
        name: 'terminal',
        arguments: JSON.stringify({ command: 'python3 -c "print(123)"' }),
      },
    });
  });

  it('maps common Cursor stream tool names to Hermes/OpenAI-compatible tool names', () => {
    expect(
      mapCursorStreamToolCall({
        subtype: 'started',
        tool_call: { name: 'readToolCall', args: { path: 'a' } },
      })?.function.name,
    ).toBe('read_file');
    expect(
      mapCursorStreamToolCall({
        subtype: 'started',
        tool_call: { name: 'writeToolCall', args: { path: 'a', content: 'b' } },
      })?.function.name,
    ).toBe('write_file');
    expect(
      mapCursorStreamToolCall({
        subtype: 'started',
        tool_call: { name: 'searchReplaceToolCall', args: { path: 'a' } },
      })?.function.name,
    ).toBe('patch');
    expect(
      mapCursorStreamToolCall({
        subtype: 'started',
        tool_call: { name: 'grepToolCall', args: { pattern: 'x' } },
      })?.function.name,
    ).toBe('search_files');
    expect(
      mapCursorStreamToolCall({
        subtype: 'started',
        tool_call: { name: 'listDirToolCall', args: { path: '.' } },
      })?.function.name,
    ).toBe('search_files');
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
