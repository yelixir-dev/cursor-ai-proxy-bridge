import { chainTools, lookupTool } from './config.mjs';
import { assert, callsFrom, chat, parseArguments } from './http.mjs';

export function dependentScenarios({ baseUrl }) {
  return [
    {
      id: 'dependent 3-2-2 multi-tool conversation',
      run: async () => {
        const history = [
          {
            role: 'user',
            content:
              'Round 1: call chain_alpha with CHAIN_R1_A, chain_beta with CHAIN_R1_B, and chain_gamma with CHAIN_R1_C in parallel. Call every named tool exactly once and do not answer directly.',
          },
        ];
        const first = await chat(baseUrl, {
          messages: history,
          tools: chainTools,
          tool_choice: 'required',
          parallel_tool_calls: true,
        });
        assert(first.response.status === 200, `round 1 returned ${first.response.status}`);
        const firstCalls = callsFrom(first.body);
        assert(firstCalls.length === 3, `round 1 expected three calls, got ${firstCalls.length}`);
        assert(
          JSON.stringify(
            firstCalls.map((call) => `${call.function.name}:${parseArguments(call).value}`).sort(),
          ) ===
            JSON.stringify([
              'chain_alpha:CHAIN_R1_A',
              'chain_beta:CHAIN_R1_B',
              'chain_gamma:CHAIN_R1_C',
            ]),
          'round 1 args differ',
        );
        const firstResults = new Map([
          ['CHAIN_R1_A', 'ROUND2_VALUE_A'],
          ['CHAIN_R1_B', 'ROUND2_VALUE_B'],
          ['CHAIN_R1_C', 'ROUND2_UNUSED'],
        ]);
        history.push(
          { role: 'assistant', content: null, tool_calls: firstCalls },
          ...firstCalls.map((call) => ({
            role: 'tool',
            tool_call_id: call.id,
            content: firstResults.get(parseArguments(call).value),
          })),
          {
            role: 'user',
            content:
              'Round 2: use the preceding tool results. Call chain_alpha with exact value ROUND2_VALUE_A and chain_beta with exact value ROUND2_VALUE_B in parallel. Call both tools exactly once, ignore ROUND2_UNUSED, and do not answer directly.',
          },
        );

        const second = await chat(baseUrl, {
          messages: history,
          tools: chainTools,
          tool_choice: 'required',
          parallel_tool_calls: true,
        });
        assert(second.response.status === 200, `round 2 returned ${second.response.status}`);
        const secondCalls = callsFrom(second.body);
        assert(secondCalls.length === 2, `round 2 expected two calls, got ${secondCalls.length}`);
        assert(
          JSON.stringify(
            secondCalls.map((call) => `${call.function.name}:${parseArguments(call).value}`).sort(),
          ) === JSON.stringify(['chain_alpha:ROUND2_VALUE_A', 'chain_beta:ROUND2_VALUE_B']),
          'round 2 args differ',
        );
        const secondResults = new Map([
          ['ROUND2_VALUE_A', 'ROUND3_VALUE_A'],
          ['ROUND2_VALUE_B', 'ROUND3_VALUE_B'],
        ]);
        history.push(
          { role: 'assistant', content: null, tool_calls: secondCalls },
          ...secondCalls.map((call) => ({
            role: 'tool',
            tool_call_id: call.id,
            content: secondResults.get(parseArguments(call).value),
          })),
          {
            role: 'user',
            content:
              'Round 3: use the preceding tool results. Call chain_beta with exact value ROUND3_VALUE_A and chain_gamma with exact value ROUND3_VALUE_B in parallel. Call both tools exactly once and do not answer directly.',
          },
        );

        const third = await chat(baseUrl, {
          messages: history,
          tools: chainTools,
          tool_choice: 'required',
          parallel_tool_calls: true,
        });
        assert(third.response.status === 200, `round 3 returned ${third.response.status}`);
        const thirdCalls = callsFrom(third.body);
        assert(thirdCalls.length === 2, `round 3 expected two calls, got ${thirdCalls.length}`);
        assert(
          JSON.stringify(
            thirdCalls.map((call) => `${call.function.name}:${parseArguments(call).value}`).sort(),
          ) === JSON.stringify(['chain_beta:ROUND3_VALUE_A', 'chain_gamma:ROUND3_VALUE_B']),
          'round 3 args differ',
        );
      },
    },
    {
      id: 'auto tool-result-only follow-up continues the loop',
      run: async () => {
        const initial = {
          role: 'user',
          content:
            'Call lookup_code exactly once with key AUTO_FOLLOW_KEY. After that tool result is supplied, call lookup_code exactly once with key AUTO_NEXT_KEY. Do not give a final answer until the second result is supplied.',
        };
        const first = await chat(baseUrl, {
          messages: [initial],
          tools: [lookupTool],
          tool_choice: 'auto',
        });
        assert(first.response.status === 200, `round 1 returned ${first.response.status}`);
        const firstCalls = callsFrom(first.body);
        assert(firstCalls.length === 1, `round 1 expected one call, got ${firstCalls.length}`);
        assert(parseArguments(firstCalls[0]).key === 'AUTO_FOLLOW_KEY', 'round 1 args differ');
        const second = await chat(baseUrl, {
          messages: [
            initial,
            { role: 'assistant', content: null, tool_calls: firstCalls },
            {
              role: 'tool',
              tool_call_id: firstCalls[0].id,
              content:
                'First lookup is done. Now call lookup_code exactly once with key AUTO_NEXT_KEY.',
            },
          ],
          tools: [lookupTool],
          tool_choice: 'auto',
        });
        assert(second.response.status === 200, `round 2 returned ${second.response.status}`);
        const secondCalls = callsFrom(second.body);
        assert(secondCalls.length === 1, `round 2 expected one call, got ${secondCalls.length}`);
        assert(parseArguments(secondCalls[0]).key === 'AUTO_NEXT_KEY', 'round 2 args differ');
      },
    },
  ];
}
