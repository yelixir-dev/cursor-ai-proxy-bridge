import { describe, expect, it } from 'vitest';
import { ToolTextStreamFilter } from '../src/backend/tool-call-stream.js';

describe('tool text stream filtering', () => {
  it('streams ordinary leading JSON after classifying its first key', () => {
    const filter = new ToolTextStreamFilter(true);
    const json = JSON.stringify({ answer: 'x'.repeat(256) });

    const streamed = filter.push(json);

    expect(streamed.length).toBeGreaterThan(0);
    expect(streamed + filter.finish()).toBe(json);
  });

  it('streams fenced JSON after classifying its first key', () => {
    const filter = new ToolTextStreamFilter(true);
    const content = `\`\`\`json\n${JSON.stringify({ answer: 'x'.repeat(256) })}\n\`\`\``;

    const streamed = filter.push(content);

    expect(streamed.length).toBeGreaterThan(0);
    expect(streamed + filter.finish()).toBe(content);
  });

  it('suppresses split raw JSON tool payloads', () => {
    const filter = new ToolTextStreamFilter(true);

    const first = filter.push('{"tool_');
    const second = filter.push('calls":[{"function":{"name":"unknown_tool","arguments":{}}}]}');

    expect(first + second + filter.finish()).toBe('');
  });

  it('suppresses same-line fenced JSON tool payloads', () => {
    const filter = new ToolTextStreamFilter(true);
    const content =
      '```json {"tool_calls":[{"function":{"name":"unknown_tool","arguments":{}}}]}```';

    expect(filter.push(content) + filter.finish()).toBe('');
  });

  it('suppresses case-insensitive JSON fences and escaped tool keys', () => {
    const fenced = new ToolTextStreamFilter(true);
    const escaped = new ToolTextStreamFilter(true);

    expect(
      fenced.push(
        '```JSON {"tool_calls":[{"function":{"name":"unknown_tool","arguments":{}}}]}```',
      ) + fenced.finish(),
    ).toBe('');
    expect(
      escaped.push('{"tool_\\u0063alls":[{"function":{"name":"unknown_tool","arguments":{}}}]}') +
        escaped.finish(),
    ).toBe('');
  });

  it('waits across long leading whitespace before classifying a tool key', () => {
    const filter = new ToolTextStreamFilter(true);

    const first = filter.push(`{${' '.repeat(300)}`);
    const second = filter.push(
      '"tool_calls":[{"function":{"name":"unknown_tool","arguments":{}}}]}',
    );

    expect(first + second + filter.finish()).toBe('');
  });
});
