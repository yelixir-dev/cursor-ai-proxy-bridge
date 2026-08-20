/* global AbortSignal */
import { echoTool } from './config.mjs';
import { abortAfterFirstByte, assert, parseArguments, readSse } from './http.mjs';

export function streamingScenarios({ baseUrl, traceProvenance, triggerAndAwaitAbortQuiescence }) {
  return [
    {
      id: 'streaming incremental TTFB and usage',
      run: async () => {
        const stream = await readSse(baseUrl, {
          stream_options: { include_usage: true },
          messages: [
            {
              role: 'user',
              content:
                'Write the numbers 1 through 40 in order, separated by commas, with no omissions.',
            },
          ],
        });
        assert(
          stream.ttfbMs < stream.totalMs,
          `TTFB ${stream.ttfbMs}ms was not below total ${stream.totalMs}ms`,
        );
        const usage = stream.frames.find((frame) => frame.choices?.length === 0)?.usage;
        assert(usage && typeof usage.total_tokens === 'number', 'include_usage chunk missing');
        const content = stream.frames
          .map((frame) => frame.choices?.[0]?.delta?.content || '')
          .join('');
        assert(!content.includes('[TOOL_CALLS'), 'tool marker leaked in content delta');
        return `TTFB ${(stream.ttfbMs / 1000).toFixed(2)}s < total ${(stream.totalMs / 1000).toFixed(2)}s`;
      },
    },
    {
      id: 'tool-declared text streams before completion',
      run: async () => {
        const stream = await readSse(baseUrl, {
          messages: [
            {
              role: 'user',
              content:
                'Do not call any tool. Write exactly 80 short numbered lines, from 1 to 80, one line at a time.',
            },
          ],
          tools: [echoTool],
          tool_choice: 'auto',
        });
        assert(
          stream.ttfbMs + 100 < stream.totalMs,
          `tool-declared TTFB ${stream.ttfbMs}ms was not meaningfully below total ${stream.totalMs}ms`,
        );
        const toolDeltas = stream.frames.flatMap(
          (frame) => frame.choices?.[0]?.delta?.tool_calls || [],
        );
        assert(toolDeltas.length === 0, 'ordinary streaming response unexpectedly called a tool');
        const content = stream.frames
          .map((frame) => frame.choices?.[0]?.delta?.content || '')
          .join('');
        assert(content.includes('80'), 'ordinary streaming response was incomplete');
        return `TTFB ${(stream.ttfbMs / 1000).toFixed(2)}s < total ${(stream.totalMs / 1000).toFixed(2)}s`;
      },
    },
    {
      id: 'streaming indexed tool calls',
      run: async () => {
        const stream = await readSse(baseUrl, {
          stream_options: { include_usage: true },
          messages: [
            {
              role: 'user',
              content:
                'Delegate one echo_value call with value STREAM_TOOL_55. Do not answer directly.',
            },
          ],
          tools: [echoTool],
          tool_choice: 'required',
        });
        const contentDeltas = stream.frames.map(
          (frame) => frame.choices?.[0]?.delta?.content || '',
        );
        assert(
          !contentDeltas.some((content) => content.includes('[TOOL_CALLS')),
          'marker leaked in content delta',
        );
        const toolDeltas = stream.frames.flatMap(
          (frame) => frame.choices?.[0]?.delta?.tool_calls || [],
        );
        assert(toolDeltas.length > 0, 'stream returned no tool_calls delta');
        assert(
          toolDeltas.every((call) => Number.isInteger(call.index)),
          'stream tool call lacks index',
        );
        assert(parseArguments(toolDeltas[0]).value === 'STREAM_TOOL_55', 'stream tool args differ');
        const usage = stream.frames.find((frame) => frame.choices?.length === 0)?.usage;
        assert(
          usage && typeof usage.total_tokens === 'number',
          'stream tool include_usage chunk missing',
        );
      },
    },
    {
      id: 'stream abort reaps cursor-agent',
      run: async () => {
        await triggerAndAwaitAbortQuiescence({
          provenance: traceProvenance,
          signal: AbortSignal.timeout(10_000),
          trigger: () => abortAfterFirstByte(baseUrl),
        });
      },
    },
  ];
}
