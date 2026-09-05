/* global AbortController, AbortSignal, fetch, TextDecoder */
import { executeTool, toolsFor } from '../native-parity-mcp.mjs';

export function createSseParser(onEvent) {
  let pending = '';
  let data = [];
  const line = (value) => {
    if (value === '') {
      if (data.length) {
        const text = data.join('\n');
        data = [];
        onEvent(text === '[DONE]' ? text : JSON.parse(text));
      }
    } else if (value.startsWith('data:')) data.push(value.slice(5).replace(/^ /, ''));
  };
  return {
    push(text) {
      pending += text;
      if (pending.length > 4 * 1024 * 1024) throw new Error('sse_line_limit');
      let index = pending.indexOf('\n');
      while (index !== -1) {
        line(pending.slice(0, index).replace(/\r$/, ''));
        pending = pending.slice(index + 1);
        index = pending.indexOf('\n');
      }
    },
    finish() {
      if (pending || data.length) throw new Error('truncated_sse');
    },
  };
}

async function releaseReader(reader, cancelled) {
  try {
    await reader.cancel();
  } catch (error) {
    if (!cancelled || error.name !== 'AbortError') throw error;
  } finally {
    reader.releaseLock();
  }
}

export async function runBridgeTurn({
  url,
  caseId,
  prompt,
  state,
  signal,
  onEvent = () => {},
  onHttp = () => {},
  onCancel = () => {},
}) {
  const messages = [{ role: 'user', content: prompt }];
  const tools = toolsFor(caseId).map(({ name, description, inputSchema }) => ({
    type: 'function',
    function: { name, description, parameters: inputSchema },
  }));
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let cancelled = false;
  let text = '';
  const rounds = [];
  for (let round = 0; round < 4; round++) {
    text = '';
    const calls = new Map();
    let done = false;
    let finishReason = null;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: combined,
      body: JSON.stringify({
        model: 'composer-2.5',
        messages,
        stream: true,
        ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
      }),
    });
    onHttp({
      type: 'response',
      round,
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers),
    });
    if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) {
      await response.body?.cancel();
      throw new Error(`bridge_http_${response.status}`);
    }
    const parser = createSseParser((event) => {
      if (cancelled) return;
      onEvent(event);
      if (event === '[DONE]') {
        done = true;
        return;
      }
      if (done || event.error) throw new Error('invalid_sse_event');
      const choice = event.choices?.find((c) => c.index === 0) ?? event.choices?.[0];
      if (!choice) return;
      const delta = choice.delta ?? {};
      if (typeof delta.content === 'string' && delta.content.length) {
        text += delta.content;
        if (caseId === 'cancel') {
          cancelled = true;
          onCancel();
          controller.abort();
          return;
        }
      }
      for (const fragment of delta.tool_calls ?? []) {
        if (!Number.isInteger(fragment.index) || fragment.index < 0)
          throw new Error('invalid_tool_index');
        const call = calls.get(fragment.index) ?? {
          id: '',
          type: 'function',
          function: { name: '', arguments: '' },
        };
        if (fragment.id) call.id += fragment.id;
        if (fragment.function?.name) call.function.name += fragment.function.name;
        if (fragment.function?.arguments) call.function.arguments += fragment.function.arguments;
        calls.set(fragment.index, call);
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const text = decoder.decode(chunk.value, { stream: true });
        onHttp({ type: 'data', round, text });
        parser.push(text);
        if (cancelled) break;
      }
      if (!cancelled) {
        parser.push(decoder.decode());
        parser.finish();
      }
    } finally {
      await releaseReader(reader, cancelled);
    }
    if (cancelled) return { text, calls: state.calls, cancelled, terminal: false, rounds };
    if (!done || !finishReason) throw new Error('incomplete_sse_turn');
    const complete = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
    rounds.push({ toolCount: complete.length, finishReason });
    if (!complete.length)
      return { text, calls: state.calls, terminal: finishReason === 'stop', cancelled, rounds };
    if (
      finishReason !== 'tool_calls' ||
      complete.some((c) => !c.id || !c.function.name) ||
      new Set(complete.map((c) => c.id)).size !== complete.length
    )
      throw new Error('invalid_complete_tools');
    messages.push({ role: 'assistant', content: text || null, tool_calls: complete });
    for (const call of complete) {
      const result = executeTool(state, call.function.name, JSON.parse(call.function.arguments));
      messages.push({ role: 'tool', tool_call_id: call.id, content: result.content[0].text });
    }
  }
  throw new Error('tool_round_limit');
}
