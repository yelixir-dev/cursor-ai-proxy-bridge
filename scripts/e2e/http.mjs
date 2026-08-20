/* global AbortSignal, Buffer, fetch, performance */
import { request as httpRequest } from 'node:http';
import { API_KEY, MODEL, REQUEST_TIMEOUT_MS } from './config.mjs';

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function authHeaders() {
  return {
    authorization: `Bearer ${API_KEY}`,
    'content-type': 'application/json',
  };
}

export async function jsonRequest(baseUrl, requestPath, options = {}) {
  const response = await fetch(`${baseUrl}${requestPath}`, {
    ...options,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(
      `${requestPath} returned non-JSON status ${response.status}: ${text.slice(0, 300)}`,
    );
  }
  return { response, body };
}

export async function chat(baseUrl, payload) {
  return jsonRequest(baseUrl, '/v1/chat/completions', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ model: MODEL, ...payload }),
  });
}

export function messageFrom(body) {
  return body?.choices?.[0]?.message;
}

export function callsFrom(body) {
  return messageFrom(body)?.tool_calls || [];
}

export function parseArguments(call) {
  assert(call?.type === 'function', 'tool call type is not function');
  assert(typeof call.function?.name === 'string', 'tool call has no function name');
  assert(typeof call.function?.arguments === 'string', 'tool arguments are not a JSON string');
  const args = JSON.parse(call.function.arguments);
  assert(
    args && typeof args === 'object' && !Array.isArray(args),
    'tool arguments are not an object',
  );
  return args;
}

export function sseFrames(text) {
  return text
    .split('\n\n')
    .filter((frame) => frame.startsWith('data: {'))
    .map((frame) => JSON.parse(frame.slice('data: '.length)));
}

export async function readSse(baseUrl, payload) {
  const started = performance.now();
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ model: MODEL, stream: true, ...payload }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status !== 200) {
    throw new Error(`stream returned ${response.status}: ${await response.text()}`);
  }
  assert(response.body, 'stream response has no body');
  const reader = response.body.getReader();
  const chunks = [];
  let firstByteAt;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    if (firstByteAt === undefined) firstByteAt = performance.now();
    chunks.push(Buffer.from(next.value));
  }
  const ended = performance.now();
  assert(firstByteAt !== undefined, 'stream returned no bytes');
  const text = Buffer.concat(chunks).toString('utf8');
  assert(text.trim().endsWith('data: [DONE]'), 'stream did not terminate with [DONE]');
  return { text, frames: sseFrames(text), ttfbMs: firstByteAt - started, totalMs: ended - started };
}

export async function abortAfterFirstByte(baseUrl) {
  const payload = JSON.stringify({
    model: MODEL,
    stream: true,
    messages: [
      {
        role: 'user',
        content:
          'Write a detailed numbered explanation with at least 200 separate items. Begin immediately and do not use tools.',
      },
    ],
  });
  await new Promise((resolve, reject) => {
    const request = httpRequest(
      `${baseUrl}/v1/chat/completions`,
      {
        method: 'POST',
        headers: { ...authHeaders(), 'content-length': Buffer.byteLength(payload) },
      },
      (response) => {
        response.once('data', () => {
          response.destroy();
          request.destroy();
          resolve();
        });
        response.once('error', (error) => {
          if (!response.destroyed) reject(error);
        });
        response.resume();
      },
    );
    request.once('error', (error) => {
      if (!request.destroyed) reject(error);
    });
    request.setTimeout(REQUEST_TIMEOUT_MS, () =>
      request.destroy(new Error('abort stream deadline exceeded')),
    );
    request.end(payload);
  });
}
