import { lookupTool, stepTool } from './config.mjs';
import { assert, callsFrom, chat, messageFrom, parseArguments } from './http.mjs';

export function historyScenarios({ baseUrl }) {
  return [
    {
      id: 'sequential two-round tool conversation',
      run: async () => {
        const initial = {
          role: 'user',
          content:
            'Round 1: call lookup_code exactly once with key SEQUENTIAL_KEY. Do not give a final answer until its tool result is supplied.',
        };
        const first = await chat(baseUrl, {
          messages: [initial],
          tools: [lookupTool],
          tool_choice: 'auto',
        });
        assert(first.response.status === 200, `round 1 returned ${first.response.status}`);
        const calls = callsFrom(first.body);
        assert(calls.length === 1, `round 1 expected one call, got ${calls.length}`);
        assert(parseArguments(calls[0]).key === 'SEQUENTIAL_KEY', 'round 1 args differ');
        const finalSentinel = 'SEQUENTIAL_FINAL_91';
        const second = await chat(baseUrl, {
          messages: [
            initial,
            { role: 'assistant', content: null, tool_calls: calls },
            {
              role: 'tool',
              tool_call_id: calls[0].id,
              content: `The lookup result is ${finalSentinel}. Reply with exactly that result and do not call another tool.`,
            },
          ],
          tools: [lookupTool],
          tool_choice: 'auto',
        });
        assert(second.response.status === 200, `round 2 returned ${second.response.status}`);
        assert(
          callsFrom(second.body).length === 0,
          'round 2 unexpectedly returned another tool call',
        );
        assert(
          messageFrom(second.body)?.content?.includes(finalSentinel),
          'round 2 omitted final content',
        );
      },
    },
    {
      id: 'Composer defaults to ten single-call rounds',
      run: async () => {
        const history = [
          {
            role: 'user',
            content:
              'Run ten sequential rounds. In each response call record_step exactly once with the next round number, starting at 1. Wait for each tool result before requesting the next round. Do not answer directly.',
          },
        ];

        for (let round = 1; round <= 10; round += 1) {
          const result = await chat(baseUrl, {
            messages: history,
            tools: [stepTool],
            tool_choice: 'auto',
          });
          assert(
            result.response.status === 200,
            `round ${round} returned ${result.response.status}`,
          );
          const roundCalls = callsFrom(result.body);
          assert(
            roundCalls.length === 1,
            `round ${round} expected one call, got ${roundCalls.length}`,
          );
          assert(
            parseArguments(roundCalls[0]).round === round,
            `round ${round} returned different arguments`,
          );
          history.push(
            { role: 'assistant', content: null, tool_calls: roundCalls },
            {
              role: 'tool',
              tool_call_id: roundCalls[0].id,
              content: `Round ${round} accepted.`,
            },
          );
        }
      },
    },
  ];
}
