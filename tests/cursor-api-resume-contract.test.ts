import { describe, expect, it, vi } from 'vitest';
import {
  captureContinuationContract,
  type HeldRun,
  stickyKey,
  StickyRunStore,
} from '../src/backend/cursor-api/sticky-run-store.js';
import type { ChatCompletionRequest, ChatMessage, ToolCall } from '../src/backend/types.js';

function initial(): ChatCompletionRequest {
  return {
    model: 'sonnet-5',
    messages: [
      { role: 'system', content: 'Use the tools faithfully.' },
      { role: 'user', content: 'Read then echo.' },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'read_value',
          description: 'Read a value',
          parameters: {
            type: 'object',
            properties: { key: { type: 'string' } },
            required: ['key'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'echo_value',
          description: 'Echo a value',
          parameters: { type: 'object', properties: { value: { type: 'string' } } },
        },
      },
    ],
  };
}

function assistant(id = 'call-a'): ChatMessage {
  return {
    role: 'assistant',
    content: '',
    tool_calls: [
      { id, type: 'function', function: { name: 'read_value', arguments: '{"key":"a"}' } },
    ],
  };
}

function continuation(request = initial(), surfaced = assistant()): ChatCompletionRequest {
  return {
    ...structuredClone(request),
    messages: [
      ...structuredClone(request.messages),
      structuredClone(surfaced),
      ...(surfaced.tool_calls ?? []).map((call) => ({
        role: 'tool' as const,
        tool_call_id: call.id,
        content: 'result',
      })),
    ],
  };
}

function held(
  request = initial(),
  surfaced = assistant(),
  credentialId = 'original-account',
): HeldRun {
  return {
    key: stickyKey((surfaced.tool_calls ?? []).map((call) => call.id)),
    credentialId,
    continuation: captureContinuationContract(request, false, [...request.messages, surfaced]),
    resume: vi.fn(),
    release: vi.fn(),
  };
}

const changes: Array<[string, (request: ChatCompletionRequest) => ChatCompletionRequest]> = [
  ['model', (request) => ({ ...request, model: 'composer-2.5' })],
  ['reasoning effort', (request) => ({ ...request, reasoning_effort: 'high' })],
  ['tool choice', (request) => ({ ...request, tool_choice: 'required' })],
  [
    'forced tool choice',
    (request) => ({
      ...request,
      tool_choice: { type: 'function', function: { name: 'echo_value' } },
    }),
  ],
  ['parallel policy', (request) => ({ ...request, parallel_tool_calls: false })],
  ['call limit', (request) => ({ ...request, max_tool_calls: 1 })],
  [
    'tool description',
    (request) => ({
      ...request,
      tools: request.tools?.map((tool) => ({
        ...tool,
        function: { ...tool.function, description: 'Different behavior' },
      })),
    }),
  ],
  [
    'tool schema',
    (request) => ({
      ...request,
      tools: request.tools?.map((tool) => ({
        ...tool,
        function: {
          ...tool.function,
          parameters: { type: 'object', properties: { key: { type: 'number' } } },
        },
      })),
    }),
  ],
  [
    'tool name',
    (request) => ({
      ...request,
      tools: request.tools?.map((tool) => ({
        ...tool,
        function: { ...tool.function, name: 'different_tool' },
      })),
    }),
  ],
  ['tool order', (request) => ({ ...request, tools: request.tools?.toReversed() })],
  ['removed tools', (request) => ({ ...request, tools: [] })],
  [
    'system history',
    (request) => ({
      ...request,
      messages: request.messages.map((message) =>
        message.role === 'system' ? { ...message, content: 'Different system' } : message,
      ),
    }),
  ],
  [
    'user history',
    (request) => ({
      ...request,
      messages: request.messages.map((message) =>
        message.role === 'user' ? { ...message, content: 'Different question' } : message,
      ),
    }),
  ],
  [
    'assistant text',
    (request) => ({
      ...request,
      messages: request.messages.map((message) =>
        message.role === 'assistant' ? { ...message, content: 'Invented assistant text' } : message,
      ),
    }),
  ],
  [
    'surfaced call arguments',
    (request) => ({
      ...request,
      messages: request.messages.map((message) =>
        message.role === 'assistant'
          ? {
              ...message,
              tool_calls: message.tool_calls?.map((call) => ({
                ...call,
                function: { ...call.function, arguments: '{"key":"tampered"}' },
              })),
            }
          : message,
      ),
    }),
  ],
  [
    'surfaced call name',
    (request) => ({
      ...request,
      messages: request.messages.map((message) =>
        message.role === 'assistant'
          ? {
              ...message,
              tool_calls: message.tool_calls?.map((call) => ({
                ...call,
                function: { ...call.function, name: 'echo_value' },
              })),
            }
          : message,
      ),
    }),
  ],
  ['missing prior history', (request) => ({ ...request, messages: request.messages.slice(2) })],
];

describe('immutable sticky continuation contract', () => {
  it('bounds retained contract bytes independently of conversation length', () => {
    // Given: a large conversation already retained by the running session.
    const request = initial();
    request.messages = [{ role: 'user', content: 'x'.repeat(1_000_000) }];

    // When: the continuation compatibility snapshot is captured.
    const contract = captureContinuationContract(request, false);

    // Then: the comparison key must not duplicate the conversation in memory.
    expect(Buffer.byteLength(contract.fingerprint)).toBeLessThanOrEqual(128);
    expect(contract.fingerprint).not.toBe(
      captureContinuationContract({ ...request, model: 'composer-2.5' }, false).fingerprint,
    );
  });

  it('captures a frozen value detached from mutable tools, policy, messages, and surfaced calls', () => {
    const request = initial();
    request.tool_choice = { type: 'function', function: { name: 'read_value' } };
    const surfaced = assistant();
    const unchanged = continuation(request, surfaced);
    const run = held(request, surfaced);
    const snapshot = run.continuation.fingerprint;
    expect(Object.isFrozen(run.continuation)).toBe(true);
    request.model = 'different-model';
    request.tool_choice.function.name = 'echo_value';
    request.messages[0] = { role: 'system', content: 'mutated' };
    const tool = request.tools?.[0];
    if (!tool) throw new Error('Expected fixture tool');
    tool.function.parameters = { type: 'object', properties: { other: { type: 'number' } } };
    const call = surfaced.tool_calls?.[0];
    if (!call) throw new Error('Expected fixture call');
    call.function.arguments = '{"mutated":true}';
    const store = new StickyRunStore();
    store.park(run);
    expect(run.continuation.fingerprint).toBe(snapshot);
    expect(store.take(unchanged, false)).toBe(run);
    expect(store.size()).toBe(0);
  });

  it('normalizes mapped tool defaults and schema object key order', () => {
    const request = initial();
    request.tools = [{ type: 'function', function: { name: 'read_value' } }];
    const store = new StickyRunStore();
    const run = held(request);
    store.park(run);
    const resumed = continuation(request);
    resumed.tools = [
      {
        type: 'function',
        function: { parameters: { type: 'object' }, description: '', name: 'read_value' },
      },
    ];
    expect(store.take(resumed, false)).toBe(run);
    const schemaRequest = initial();
    const schemaRun = held(schemaRequest);
    store.park(schemaRun);
    const reordered = continuation(schemaRequest);
    const tool = reordered.tools?.[0];
    if (!tool) throw new Error('Expected fixture tool');
    tool.function.parameters = {
      required: ['key'],
      properties: { key: { type: 'string' } },
      type: 'object',
    };
    expect(store.take(reordered, false)).toBe(schemaRun);
    expect(store.size()).toBe(0);
  });

  it.each(['kimi-k3', 'glm-5.2'])('normalizes the default high effort for %s', (model) => {
    const request = { ...initial(), model };
    const store = new StickyRunStore();
    const run = held(request);
    store.park(run);
    expect(store.take({ ...continuation(request), reasoning_effort: 'high' }, false)).toBe(run);
    expect(store.size()).toBe(0);
  });

  it('normalizes omitted tools to an empty mapped tool list', () => {
    const request = initial();
    delete request.tools;
    const store = new StickyRunStore();
    const run = held(request);
    store.park(run);
    expect(store.take({ ...continuation(request), tools: [] }, false)).toBe(run);
    expect(store.size()).toBe(0);
  });

  it('releases only the invalidated credential and is idempotent', () => {
    const store = new StickyRunStore();
    const first = held();
    const second = held(initial(), assistant('call-b'));
    const unrelated = held(initial(), assistant('call-other'), 'other-account');
    for (const run of [first, second, unrelated]) store.park(run);
    const reason = new Error('Credential replaced');
    expect(store.releaseCredential('original-account', reason)).toBe(2);
    expect(store.size()).toBe(1);
    expect(store.releaseCredential('original-account', reason)).toBe(0);
    expect(store.take(continuation(), false)).toBeUndefined();
    for (const run of [first, second]) {
      expect(run.release).toHaveBeenCalledExactlyOnceWith(reason);
      expect(store.release(run)).toBe(false);
    }
    expect(store.take(continuation(initial(), assistant('call-other')), false)).toBe(unrelated);
    expect(unrelated.release).not.toHaveBeenCalled();
    expect(store.size()).toBe(0);
  });

  it('removes an incompatible hold before its release callback can reenter the store', () => {
    const store = new StickyRunStore();
    const run = held();
    const release = vi.fn((): void => {
      expect(store.release(reentrant)).toBe(false);
    });
    const reentrant = { ...run, release };
    store.park(reentrant);
    expect(store.take({ ...continuation(), max_tool_calls: 1 }, false)).toBeUndefined();
    store.clear();
    expect(release).toHaveBeenCalledOnce();
    expect(store.size()).toBe(0);
  });

  it.each(changes)(
    'releases a matching incompatible %s hold once and preserves unrelated holds',
    (_label, change) => {
      const store = new StickyRunStore();
      const run = held();
      const unrelated = held(initial(), assistant('call-unrelated'), 'another-account');
      store.park(run);
      store.park(unrelated);
      const changed = change(continuation());

      expect(store.take(changed, false)).toBeUndefined();
      expect(store.size()).toBe(1);
      expect(store.take(changed, false)).toBeUndefined();
      expect(store.release(run)).toBe(false);
      expect(run.release).toHaveBeenCalledOnce();
      expect(run.resume).not.toHaveBeenCalled();
      expect(store.take(continuation(initial(), assistant('call-unrelated')), false)).toBe(
        unrelated,
      );
      expect(unrelated.release).not.toHaveBeenCalled();
      expect(store.size()).toBe(0);
    },
  );

  it('rejects changed Max policy even when the request is unchanged', () => {
    const store = new StickyRunStore();
    const run = held();
    store.park(run);
    expect(store.take(continuation(), true)).toBeUndefined();
    expect(store.size()).toBe(0);
    expect(store.release(run)).toBe(false);
    expect(run.release).toHaveBeenCalledOnce();
  });

  it.each([
    ['unchanged', {}],
    [
      'explicit defaults',
      { reasoning_effort: 'default', tool_choice: 'auto', parallel_tool_calls: true },
    ],
    ['default medium effort', { reasoning_effort: 'medium' }],
    ['streaming transport', { stream: true, stream_options: { include_usage: true } }],
  ] satisfies Array<[string, Partial<ChatCompletionRequest>]>)(
    'reuses the original held run and credential for %s requests',
    (_label, overrides) => {
      const store = new StickyRunStore();
      const run = held();
      store.park(run);
      const taken = store.take({ ...continuation(), ...overrides }, false);
      expect(taken).toBe(run);
      expect(taken?.credentialId).toBe('original-account');
      expect(store.size()).toBe(0);
      expect(run.release).not.toHaveBeenCalled();
    },
  );

  it('preserves the exact surfaced parallel call order even though result IDs are unordered', () => {
    const first: ToolCall = {
      id: 'call-a',
      type: 'function',
      function: { name: 'read_value', arguments: '{"key":"a"}' },
    };
    const second: ToolCall = {
      id: 'call-b',
      type: 'function',
      function: { name: 'echo_value', arguments: '{"value":"b"}' },
    };
    const surfaced: ChatMessage = { role: 'assistant', content: '', tool_calls: [first, second] };
    const store = new StickyRunStore();
    const run = held(initial(), surfaced);
    store.park(run);
    const changed = continuation(initial(), { ...surfaced, tool_calls: [second, first] });
    expect(store.take(changed, false)).toBeUndefined();
    expect(store.size()).toBe(0);
    expect(run.release).toHaveBeenCalledOnce();
  });

  it('accepts reordered trailing results without reordering prior assistant calls', () => {
    const surfaced = assistant();
    surfaced.tool_calls?.push({
      id: 'call-b',
      type: 'function',
      function: { name: 'echo_value', arguments: '{}' },
    });
    const request = continuation(initial(), surfaced);
    const prefix = request.messages.slice(0, -2);
    const results = request.messages.slice(-2).toReversed();
    const store = new StickyRunStore();
    const run = held(initial(), surfaced);
    store.park(run);
    expect(store.take({ ...request, messages: [...prefix, ...results] }, false)).toBe(run);
    expect(store.size()).toBe(0);
  });

  it('uses the latest resumed history when parking a later round', () => {
    const store = new StickyRunStore();
    const first = held();
    store.park(first);
    const resumed = continuation();
    expect(store.take(resumed, false)).toBe(first);
    const nextAssistant = assistant('call-round-two');
    const second = held(resumed, nextAssistant);
    store.park(second);
    expect(store.take(continuation(resumed, nextAssistant), false)).toBe(second);
    store.park(second);
    const tampered = continuation(resumed, nextAssistant);
    tampered.messages = tampered.messages.map((message) =>
      message.tool_call_id === 'call-a'
        ? { ...message, content: 'changed earlier result' }
        : message,
    );
    expect(store.take(tampered, false)).toBeUndefined();
    expect(store.size()).toBe(0);
    expect(second.release).toHaveBeenCalledOnce();
  });
});
