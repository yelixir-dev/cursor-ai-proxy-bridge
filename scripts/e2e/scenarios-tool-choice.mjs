import { echoTool } from './config.mjs';
import { assert, callsFrom, chat, parseArguments } from './http.mjs';

export function toolChoiceScenarios({ baseUrl }) {
  return [
    {
      id: 'forced function uses model args',
      run: async () => {
        const { response, body } = await chat(baseUrl, {
          messages: [
            {
              role: 'user',
              content: 'Extract the literal value FORCED_REAL_7319 and pass it to echo_value.',
            },
          ],
          tools: [echoTool],
          tool_choice: { type: 'function', function: { name: 'echo_value' } },
        });
        assert(response.status === 200, `expected 200, got ${response.status}`);
        const calls = callsFrom(body);
        assert(calls.length === 1, `expected one forced call, got ${calls.length}`);
        assert(
          parseArguments(calls[0]).value === 'FORCED_REAL_7319',
          'forced args were empty/placeholders',
        );
      },
    },
    {
      id: 'required tool choice invokes model',
      run: async () => {
        const { response, body } = await chat(baseUrl, {
          messages: [
            {
              role: 'user',
              content: 'Call echo_value with the prompt-derived value REQUIRED_MODEL_8842.',
            },
          ],
          tools: [echoTool],
          tool_choice: 'required',
        });
        assert(response.status === 200, `expected 200, got ${response.status}`);
        const calls = callsFrom(body);
        assert(calls.length >= 1, 'required mode returned no call');
        assert(
          parseArguments(calls[0]).value === 'REQUIRED_MODEL_8842',
          'required mode did not use model-derived args',
        );
      },
    },
    {
      id: 'tool_choice none suppresses calls',
      run: async () => {
        const { response, body } = await chat(baseUrl, {
          messages: [
            {
              role: 'user',
              content:
                'A tool is declared, but answer in ordinary text with NONE_MODE_OK and do not call it.',
            },
          ],
          tools: [echoTool],
          tool_choice: 'none',
        });
        assert(response.status === 200, `expected 200, got ${response.status}`);
        assert(callsFrom(body).length === 0, 'tool_choice none returned tool_calls');
      },
    },
    {
      id: 'parallel_tool_calls false caps calls',
      run: async () => {
        const { response, body } = await chat(baseUrl, {
          messages: [
            {
              role: 'user',
              content:
                'Call echo_value for CAP_ONE and CAP_TWO. Respect the instruction that only one call may be returned.',
            },
          ],
          tools: [echoTool],
          tool_choice: 'required',
          parallel_tool_calls: false,
        });
        assert(response.status === 200, `expected 200, got ${response.status}`);
        const calls = callsFrom(body);
        assert(
          calls.length > 0 && calls.length <= 1,
          `expected at most one nonempty call set, got ${calls.length}`,
        );
        parseArguments(calls[0]);
      },
    },
  ];
}
