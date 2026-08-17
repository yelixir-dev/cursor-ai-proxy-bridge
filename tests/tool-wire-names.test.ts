import { describe, expect, it } from 'vitest';
import { mapCursorApiToolRequest } from '../src/backend/cursor-api/tool-wire-names.js';
import type { ChatCompletionRequest, ToolCall } from '../src/backend/types.js';

describe('cursor-api tool wire names', () => {
  it('namespaces request tools and restores OpenAI tool-call names', () => {
    const request: ChatCompletionRequest = {
      model: 'composer-2.5',
      messages: [
        { role: 'user', content: 'run commands' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call-history',
              type: 'function',
              function: { name: 'Shell', arguments: '{"command":"printf history"}' },
            },
          ],
        },
        { role: 'tool', content: 'history', tool_call_id: 'call-history' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'Shell',
            parameters: {
              type: 'object',
              properties: { command: { type: 'string' } },
              required: ['command'],
            },
          },
        },
        {
          type: 'function',
          function: {
            name: 'echo-value',
            parameters: {
              type: 'object',
              properties: { value: { type: 'string' } },
              required: ['value'],
            },
          },
        },
      ],
      tool_choice: { type: 'function', function: { name: 'Shell' } },
      parallel_tool_calls: true,
    };

    const mapped = mapCursorApiToolRequest(request);
    const wireNames = mapped.request.tools?.map((tool) => tool.function.name) ?? [];
    const [shellWireName, echoWireName] = wireNames;

    expect(wireNames).toHaveLength(2);
    expect(new Set(wireNames).size).toBe(2);
    expect(wireNames).not.toContain('Shell');
    expect(wireNames).not.toContain('echo-value');
    if (!shellWireName || !echoWireName) throw new Error('wire tool names were not created');
    expect(
      typeof mapped.request.tool_choice === 'object'
        ? mapped.request.tool_choice.function.name
        : undefined,
    ).toBe(shellWireName);
    expect(
      mapped.request.messages.find((message) => message.role === 'assistant')?.tool_calls?.[0]
        ?.function.name,
    ).toBe(shellWireName);
    expect(request.tools?.[0]?.function.name).toBe('Shell');
    expect(request.messages[1]?.tool_calls?.[0]?.function.name).toBe('Shell');

    const wireCalls: ToolCall[] = [
      {
        id: 'call-shell',
        type: 'function',
        function: { name: shellWireName, arguments: '{"command":"printf A"}' },
      },
      {
        id: 'call-echo',
        type: 'function',
        function: { name: 'echo-value', arguments: '{"value":"B"}' },
      },
    ];

    expect(mapped.restoreToolCalls(wireCalls)).toEqual([
      {
        id: 'call-shell',
        type: 'function',
        function: { name: 'Shell', arguments: '{"command":"printf A"}' },
      },
      {
        id: 'call-echo',
        type: 'function',
        function: { name: 'echo-value', arguments: '{"value":"B"}' },
      },
    ]);
  });

  it('leaves requests without tools unchanged', () => {
    const request: ChatCompletionRequest = {
      model: 'composer-2.5',
      messages: [{ role: 'user', content: 'hello' }],
    };

    const mapped = mapCursorApiToolRequest(request);

    expect(mapped.request).toBe(request);
    expect(mapped.restoreToolCalls([])).toEqual([]);
  });

  it('does not inject alias instructions when tool choice is none', () => {
    const request: ChatCompletionRequest = {
      model: 'composer-2.5',
      messages: [{ role: 'user', content: 'mention Shell without calling it' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'Shell',
            parameters: { type: 'object', properties: {} },
          },
        },
      ],
      tool_choice: 'none',
    };

    const mapped = mapCursorApiToolRequest(request);

    expect(mapped.request.messages).toHaveLength(1);
    expect(mapped.request.messages[0]?.role).toBe('user');
  });
});
