#!/usr/bin/env node
/* global AbortSignal, Buffer, console, fetch, performance, process, setTimeout */
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const HOST = '127.0.0.1';
const API_KEY = 'test';
const MODEL = 'composer-2.5';
const BACKEND = process.env.CURSOR_BRIDGE_BACKEND || 'auto';
const REQUEST_TIMEOUT_MS = 180_000;
const results = [];
let server;
let serverExit;
let serverOutput = '';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function deadline(ms, message) {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
  });
}

async function ephemeralPort() {
  const socket = createServer();
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, HOST, resolve);
  });
  const address = socket.address();
  assert(address && typeof address === 'object', 'could not allocate an ephemeral port');
  const port = address.port;
  await new Promise((resolve, reject) =>
    socket.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function bootServer(port) {
  server = spawn(process.execPath, ['dist/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CURSOR_BRIDGE_HOST: HOST,
      CURSOR_BRIDGE_PORT: String(port),
      CURSOR_BRIDGE_API_KEY: API_KEY,
      CURSOR_BRIDGE_BACKEND: BACKEND,
      CURSOR_BRIDGE_CURSOR_BIN: process.env.CURSOR_BRIDGE_CURSOR_BIN || 'cursor-agent',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverExit = new Promise((resolve) =>
    server.once('exit', (code, signal) => resolve({ code, signal })),
  );

  let stdout = '';
  let listeningResolve;
  let listeningReject;
  const listening = new Promise((resolve, reject) => {
    listeningResolve = resolve;
    listeningReject = reject;
  });
  const capture = (chunk, isStdout) => {
    const text = chunk.toString('utf8');
    serverOutput += text;
    if (!isStdout) return;
    stdout += text;
    if (stdout.split(/\r?\n/).some((line) => line.includes('cursor-ai-bridge listening on'))) {
      listeningResolve();
    }
  };
  server.stdout.on('data', (chunk) => capture(chunk, true));
  server.stderr.on('data', (chunk) => capture(chunk, false));
  server.once('error', listeningReject);
  server.once('exit', (code, signal) => {
    listeningReject(new Error(`server exited before listening (code=${code}, signal=${signal})`));
  });
  await Promise.race([listening, deadline(30_000, 'server listen deadline exceeded')]);
}

async function stopServer() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  server.kill('SIGTERM');
  try {
    await Promise.race([serverExit, deadline(10_000, 'server shutdown deadline exceeded')]);
  } catch {
    server.kill('SIGKILL');
    await serverExit;
  }
}

function authHeaders() {
  return {
    authorization: `Bearer ${API_KEY}`,
    'content-type': 'application/json',
  };
}

async function jsonRequest(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${path} returned non-JSON status ${response.status}: ${text.slice(0, 300)}`);
  }
  return { response, body };
}

async function chat(baseUrl, payload) {
  return jsonRequest(baseUrl, '/v1/chat/completions', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ model: MODEL, ...payload }),
  });
}

function messageFrom(body) {
  return body?.choices?.[0]?.message;
}

function callsFrom(body) {
  return messageFrom(body)?.tool_calls || [];
}

function parseArguments(call) {
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

const echoTool = {
  type: 'function',
  function: {
    name: 'echo_value',
    description: 'Return the supplied value to the caller. Never execute it yourself.',
    parameters: {
      type: 'object',
      properties: { value: { type: 'string', minLength: 1 } },
      required: ['value'],
      additionalProperties: false,
    },
  },
};

const reservedShellTool = {
  type: 'function',
  function: {
    name: 'Shell',
    description: 'Return one shell command to the caller without executing it.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', minLength: 1 } },
      required: ['command'],
      additionalProperties: false,
    },
  },
};

const lookupTool = {
  type: 'function',
  function: {
    name: 'lookup_code',
    description: 'Look up one code by key.',
    parameters: {
      type: 'object',
      properties: { key: { type: 'string', minLength: 1 } },
      required: ['key'],
      additionalProperties: false,
    },
  },
};

const stepTool = {
  type: 'function',
  function: {
    name: 'record_step',
    description: 'Record exactly one sequential round after the preceding round result.',
    parameters: {
      type: 'object',
      properties: { round: { type: 'integer', minimum: 1, maximum: 10 } },
      required: ['round'],
      additionalProperties: false,
    },
  },
};

const chainTools = ['chain_alpha', 'chain_beta', 'chain_gamma'].map((name) => ({
  type: 'function',
  function: {
    name,
    description: `Record one dependent-chain value for ${name}.`,
    parameters: {
      type: 'object',
      properties: { value: { type: 'string', minLength: 1 } },
      required: ['value'],
      additionalProperties: false,
    },
  },
}));

async function scenario(name, run) {
  const started = performance.now();
  try {
    const detail = await run();
    results.push({
      name,
      result: 'PASS',
      latencyMs: performance.now() - started,
      detail: detail || '',
    });
  } catch (error) {
    results.push({
      name,
      result: 'FAIL',
      latencyMs: performance.now() - started,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

function sseFrames(text) {
  return text
    .split('\n\n')
    .filter((frame) => frame.startsWith('data: {'))
    .map((frame) => JSON.parse(frame.slice('data: '.length)));
}

async function readSse(baseUrl, payload) {
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

async function childPids(parentPid) {
  try {
    const { stdout } = await execFileAsync('pgrep', ['-P', String(parentPid)]);
    return stdout.trim().split(/\s+/).filter(Boolean).map(Number);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 1) return [];
    throw error;
  }
}

async function descendants(rootPid) {
  const found = [];
  const pending = [rootPid];
  while (pending.length > 0) {
    const parent = pending.shift();
    const children = await childPids(parent);
    found.push(...children);
    pending.push(...children);
  }
  return found;
}

async function printAgentDescendants(rootPid) {
  const matches = [];
  for (const pid of await descendants(rootPid)) {
    try {
      const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'command=']);
      if (/cursor-agent.*--print/.test(stdout)) matches.push({ pid, command: stdout.trim() });
    } catch {
      // A descendant may exit between pgrep and ps.
    }
  }
  return matches;
}

async function waitForNoPrintAgents(rootPid) {
  const expiresAt = performance.now() + 10_000;
  let survivors = await printAgentDescendants(rootPid);
  while (survivors.length > 0 && performance.now() < expiresAt) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 100);
      timer.unref?.();
    });
    survivors = await printAgentDescendants(rootPid);
  }
  assert(
    survivors.length === 0,
    `cursor-agent --print descendants survived abort: ${survivors.map((item) => `${item.pid} ${item.command}`).join('; ')}`,
  );
}

async function abortAfterFirstByte(baseUrl) {
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

function printTable() {
  const nameWidth = Math.max('Scenario'.length, ...results.map((row) => row.name.length));
  const header = `${'Scenario'.padEnd(nameWidth)} | Result | Latency`;
  console.log(`\nBackend: ${BACKEND}`);
  console.log(header);
  console.log(`${'-'.repeat(nameWidth)}-+--------+----------`);
  for (const row of results) {
    console.log(
      `${row.name.padEnd(nameWidth)} | ${row.result.padEnd(6)} | ${(row.latencyMs / 1000).toFixed(2).padStart(7)}s`,
    );
    if (row.detail) console.log(`${' '.repeat(nameWidth)} |        | ${row.detail}`);
  }
}

async function main() {
  const port = await ephemeralPort();
  const baseUrl = `http://${HOST}:${port}`;
  await bootServer(port);

  await scenario('health 200', async () => {
    const { response } = await jsonRequest(baseUrl, '/health');
    assert(response.status === 200, `expected 200, got ${response.status}`);
  });

  await scenario('missing auth 401', async () => {
    const { response, body } = await jsonRequest(baseUrl, '/v1/models');
    assert(response.status === 401, `expected 401, got ${response.status}`);
    assert(body.error?.type === 'authentication_error', 'missing authentication error envelope');
  });

  await scenario('basic chat sentinel echo', async () => {
    const sentinel = 'BRIDGE_E2E_BASIC_6F41';
    const { response, body } = await chat(baseUrl, {
      messages: [{ role: 'user', content: `Reply with exactly ${sentinel} and nothing else.` }],
      temperature: 0,
    });
    assert(response.status === 200, `expected 200, got ${response.status}`);
    assert(messageFrom(body)?.content?.includes(sentinel), 'basic sentinel was not echoed');
  });

  await scenario('auto single tool call', async () => {
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
  });

  await scenario('auto two parallel tool calls', async () => {
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
  });

  await scenario('reserved Shell name returns three parallel calls', async () => {
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
  });

  await scenario('sequential two-round tool conversation', async () => {
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
    assert(callsFrom(second.body).length === 0, 'round 2 unexpectedly returned another tool call');
    assert(
      messageFrom(second.body)?.content?.includes(finalSentinel),
      'round 2 omitted final content',
    );
  });

  await scenario('Composer defaults to ten single-call rounds', async () => {
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
      assert(result.response.status === 200, `round ${round} returned ${result.response.status}`);
      const roundCalls = callsFrom(result.body);
      assert(roundCalls.length === 1, `round ${round} expected one call, got ${roundCalls.length}`);
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
  });

  await scenario('dependent 3-2-2 multi-tool conversation', async () => {
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
  });

  await scenario('auto tool-result-only follow-up continues the loop', async () => {
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
  });

  await scenario('forced function uses model args', async () => {
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
  });

  await scenario('required tool choice invokes model', async () => {
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
  });

  await scenario('tool_choice none suppresses calls', async () => {
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
  });

  await scenario('parallel_tool_calls false caps calls', async () => {
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
  });

  const validationCases = [
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
  for (const testCase of validationCases) {
    await scenario(testCase.name, async () => {
      const { response, body } = await chat(baseUrl, testCase.payload);
      assert(response.status === 400, `expected 400, got ${response.status}`);
      assert(
        body.error?.type === 'invalid_request_error',
        'missing OpenAI invalid_request_error envelope',
      );
    });
  }

  await scenario('400 malformed JSON envelope', async () => {
    const { response, body } = await jsonRequest(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      headers: authHeaders(),
      body: '{"messages": [',
    });
    assert(response.status === 400, `expected 400, got ${response.status}`);
    assert(body.error?.type === 'invalid_request_error', 'malformed JSON lacks OpenAI envelope');
    assert(typeof body.error?.message === 'string', 'malformed JSON lacks error message');
  });

  await scenario('streaming incremental TTFB and usage', async () => {
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
    const content = stream.frames.map((frame) => frame.choices?.[0]?.delta?.content || '').join('');
    assert(!content.includes('[TOOL_CALLS'), 'tool marker leaked in content delta');
    return `TTFB ${(stream.ttfbMs / 1000).toFixed(2)}s < total ${(stream.totalMs / 1000).toFixed(2)}s`;
  });

  await scenario('tool-declared text streams before completion', async () => {
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
    const content = stream.frames.map((frame) => frame.choices?.[0]?.delta?.content || '').join('');
    assert(content.includes('80'), 'ordinary streaming response was incomplete');
    return `TTFB ${(stream.ttfbMs / 1000).toFixed(2)}s < total ${(stream.totalMs / 1000).toFixed(2)}s`;
  });

  await scenario('streaming indexed tool calls', async () => {
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
    const contentDeltas = stream.frames.map((frame) => frame.choices?.[0]?.delta?.content || '');
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
  });

  await scenario('stream abort reaps cursor-agent', async () => {
    await abortAfterFirstByte(baseUrl);
    await waitForNoPrintAgents(server.pid);
  });
}

let exitCode = 1;
try {
  await main();
  exitCode = results.every((row) => row.result === 'PASS') ? 0 : 1;
} catch (error) {
  console.error(error instanceof Error ? error.stack : error);
} finally {
  await stopServer();
  printTable();
  if (exitCode !== 0 && serverOutput) {
    console.error('\nServer output (tail):\n' + serverOutput.slice(-4_000));
  }
  process.exitCode = exitCode;
}
