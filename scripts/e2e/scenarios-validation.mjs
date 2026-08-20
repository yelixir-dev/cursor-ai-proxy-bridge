import { echoTool } from './config.mjs';
import { assert, authHeaders, chat, jsonRequest } from './http.mjs';

const VALIDATION_CASES = [
  {
    name: '400 unknown forced name',
    payload: {
      messages: [{ role: 'user', content: 'invalid force' }],
      tools: [echoTool],
      tool_choice: { type: 'function', function: { name: 'missing_tool' } },
    },
  },
  {
    name: '400 required without tools',
    payload: {
      messages: [{ role: 'user', content: 'invalid required' }],
      tool_choice: 'required',
    },
  },
  {
    name: '400 duplicate tool names',
    payload: {
      messages: [{ role: 'user', content: 'duplicates' }],
      tools: [echoTool, echoTool],
    },
  },
  {
    name: '400 orphan tool_call_id',
    payload: {
      messages: [
        { role: 'user', content: 'start' },
        { role: 'tool', tool_call_id: 'orphan', content: 'bad' },
      ],
    },
  },
  {
    name: '400 duplicate tool call ids',
    payload: {
      messages: [
        { role: 'user', content: 'start' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'duplicate', type: 'function', function: { name: 'one', arguments: '{}' } },
            { id: 'duplicate', type: 'function', function: { name: 'two', arguments: '{}' } },
          ],
        },
      ],
    },
  },
];

export function validationScenarios({ baseUrl }) {
  return [
    ...VALIDATION_CASES.map((testCase) => ({
      id: testCase.name,
      run: async () => {
        const { response, body } = await chat(baseUrl, testCase.payload);
        assert(response.status === 400, `expected 400, got ${response.status}`);
        assert(
          body.error?.type === 'invalid_request_error',
          'missing OpenAI invalid_request_error envelope',
        );
      },
    })),
    {
      id: '400 malformed JSON envelope',
      run: async () => {
        const { response, body } = await jsonRequest(baseUrl, '/v1/chat/completions', {
          method: 'POST',
          headers: authHeaders(),
          body: '{"messages": [',
        });
        assert(response.status === 400, `expected 400, got ${response.status}`);
        assert(
          body.error?.type === 'invalid_request_error',
          'malformed JSON lacks OpenAI envelope',
        );
        assert(typeof body.error?.message === 'string', 'malformed JSON lacks error message');
      },
    },
  ];
}
