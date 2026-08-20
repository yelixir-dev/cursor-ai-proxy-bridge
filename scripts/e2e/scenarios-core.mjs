import { echoTool, reservedShellTool } from './config.mjs';
import { assert, callsFrom, chat, jsonRequest, messageFrom, parseArguments } from './http.mjs';

export function coreScenarios({ baseUrl }) {
  return [
    {
      id: 'health 200',
      run: async () => {
        const { response } = await jsonRequest(baseUrl, '/health');
        assert(response.status === 200, `expected 200, got ${response.status}`);
      },
    },
    {
      id: 'missing auth 401',
      run: async () => {
        const { response, body } = await jsonRequest(baseUrl, '/v1/models');
        assert(response.status === 401, `expected 401, got ${response.status}`);
        assert(
          body.error?.type === 'authentication_error',
          'missing authentication error envelope',
        );
      },
    },
    {
      id: 'basic chat sentinel echo',
      run: async () => {
        const sentinel = 'BRIDGE_E2E_BASIC_6F41';
        const { response, body } = await chat(baseUrl, {
          messages: [{ role: 'user', content: `Reply with exactly ${sentinel} and nothing else.` }],
          temperature: 0,
        });
        assert(response.status === 200, `expected 200, got ${response.status}`);
        assert(messageFrom(body)?.content?.includes(sentinel), 'basic sentinel was not echoed');
      },
    },
    {
      id: 'auto single tool call',
      run: async () => {
        const { response, body } = await chat(baseUrl, {
          messages: [
            {
              role: 'user',
              content:
                'Delegate exactly one echo_value call with value AUTO_SINGLE_27. Do not answer directly; follow the tool output contract.',
            },
          ],
          tools: [echoTool],
          tool_choice: 'auto',
        });
        assert(response.status === 200, `expected 200, got ${response.status}`);
        const calls = callsFrom(body);
        assert(calls.length === 1, `expected one tool call, got ${calls.length}`);
        assert(calls[0].function.name === 'echo_value', 'custom tool name changed');
        assert(
          parseArguments(calls[0]).value === 'AUTO_SINGLE_27',
          'tool args failed schema/value check',
        );
      },
    },
    {
      id: 'auto two parallel tool calls',
      run: async () => {
        const { response, body } = await chat(baseUrl, {
          messages: [
            {
              role: 'user',
              content:
                'Delegate two independent echo_value calls in one response: one value PARALLEL_A and one value PARALLEL_B. Do not answer directly.',
            },
          ],
          tools: [echoTool],
          tool_choice: 'auto',
          parallel_tool_calls: true,
        });
        assert(response.status === 200, `expected 200, got ${response.status}`);
        const calls = callsFrom(body);
        assert(calls.length === 2, `expected two parallel calls, got ${calls.length}`);
        const values = calls.map((call) => parseArguments(call).value).sort();
        assert(
          JSON.stringify(values) === JSON.stringify(['PARALLEL_A', 'PARALLEL_B']),
          'parallel args differ',
        );
      },
    },
    {
      id: 'reserved Shell name returns three parallel calls',
      run: async () => {
        const { response, body } = await chat(baseUrl, {
          messages: [
            {
              role: 'user',
              content:
                'Call Shell three times separately with commands printf A, printf B, and printf C. Return tool calls only.',
            },
          ],
          tools: [reservedShellTool],
          tool_choice: 'required',
          parallel_tool_calls: true,
        });
        assert(response.status === 200, `expected 200, got ${response.status}`);
        const calls = callsFrom(body);
        assert(calls.length === 3, `expected three Shell calls, got ${calls.length}`);
        const commands = calls.map((call) => parseArguments(call).command).sort();
        assert(
          commands.some((command) => command.includes('A')) &&
            commands.some((command) => command.includes('B')) &&
            commands.some((command) => command.includes('C')),
          'reserved Shell call arguments changed',
        );
      },
    },
  ];
}
