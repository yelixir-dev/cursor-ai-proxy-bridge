#!/usr/bin/env node
/* global AbortSignal, URL, console, fetch, process */
import { pathToFileURL } from 'node:url';

export const LIVE_TOOL_MATRIX_MODELS = Object.freeze([
  'composer-2.5',
  'composer-2.5-fast',
  'deepseek-v4-pro',
  'fable-5',
  'glm-5.3-flash',
  'gpt-5.6-sol',
  'kimi-k3',
  'opus-5',
  'qwen-3.8-27b',
  'sonnet-5',
]);

const readFileTool = {
  type: 'function',
  function: {
    name: 'read_file',
    description: 'Read one file by path.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
};

class LiveToolMatrixConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LiveToolMatrixConfigError';
  }
}

function parseRuns(value) {
  if (value === undefined) return 10;
  const runs = Number(value);
  if (!Number.isInteger(runs) || runs < 1 || runs > 100) {
    throw new LiveToolMatrixConfigError(
      'CURSOR_TOOL_MATRIX_RUNS must be an integer from 1 through 100',
    );
  }
  return runs;
}

function completionUrl(baseUrl) {
  const normalized = baseUrl.replace(/\/+$/, '');
  if (normalized.endsWith('/chat/completions')) return normalized;
  if (normalized.endsWith('/v1')) return `${normalized}/chat/completions`;
  return `${normalized}/v1/chat/completions`;
}

export function createLiveToolMatrixConfig(env) {
  if (env.CURSOR_TOOL_MATRIX_LIVE !== '1') {
    throw new LiveToolMatrixConfigError('CURSOR_TOOL_MATRIX_LIVE=1 is required');
  }
  const baseUrl = env.CURSOR_TOOL_MATRIX_BASE_URL;
  if (!baseUrl) {
    throw new LiveToolMatrixConfigError('CURSOR_TOOL_MATRIX_BASE_URL is required');
  }
  try {
    new URL(baseUrl);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new LiveToolMatrixConfigError('CURSOR_TOOL_MATRIX_BASE_URL must be a valid URL');
    }
    throw error;
  }
  return {
    baseUrl,
    apiKey: env.CURSOR_TOOL_MATRIX_API_KEY ?? env.OPENAI_API_KEY,
    models: LIVE_TOOL_MATRIX_MODELS,
    runs: parseRuns(env.CURSOR_TOOL_MATRIX_RUNS),
  };
}

function requestBody(model) {
  return {
    model,
    messages: [
      {
        role: 'user',
        content:
          'Call read_file exactly once for /tmp/cursor-tool-matrix-probe.txt. Do not call ls, find, grep, or any other tool.',
      },
    ],
    tools: [readFileTool],
    tool_choice: 'auto',
  };
}

async function requestLiveCompletion(request, config) {
  const response = await fetch(completionUrl(config.baseUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(240_000),
  });
  let body;
  try {
    body = await response.json();
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  return { status: response.status, body };
}

function exactSingleReadFile(response) {
  const toolCalls = response.body?.choices?.[0]?.message?.tool_calls;
  return (
    response.status === 200 &&
    Array.isArray(toolCalls) &&
    toolCalls.length === 1 &&
    toolCalls[0]?.function?.name === 'read_file'
  );
}

export async function runLiveToolMatrix(config, requestCompletion = requestLiveCompletion) {
  const rows = [];
  const failures = [];
  let passed = 0;
  for (const model of config.models) {
    let modelPassed = 0;
    for (let run = 1; run <= config.runs; run += 1) {
      const request = requestBody(model);
      try {
        const response = await requestCompletion(request, config);
        if (exactSingleReadFile(response)) {
          modelPassed += 1;
          passed += 1;
        } else {
          failures.push({ model, run, reason: `unexpected_response_${response.status}` });
        }
      } catch (error) {
        failures.push({
          model,
          run,
          reason: error instanceof Error ? error.name : 'UnknownError',
        });
      }
    }
    rows.push({ model, passed: modelPassed, total: config.runs });
  }
  return {
    rows,
    failures,
    passed,
    total: config.models.length * config.runs,
  };
}

function printResult(result) {
  console.log('Model              Result');
  console.log('------------------ ------');
  for (const row of result.rows) {
    console.log(`${row.model.padEnd(18)} ${row.passed}/${row.total}`);
  }
  console.log(`\nTotal: ${result.passed}/${result.total} exact single read_file calls`);
  for (const failure of result.failures) {
    console.error(`${failure.model} run ${failure.run}: ${failure.reason}`);
  }
}

function printHelp() {
  console.log(`Usage: CURSOR_TOOL_MATRIX_LIVE=1 \\
  CURSOR_TOOL_MATRIX_BASE_URL=http://127.0.0.1:9995 \\
  npm run test:live-tools

Optional:
  CURSOR_TOOL_MATRIX_API_KEY  Bearer key for the OpenAI-compatible endpoint
  CURSOR_TOOL_MATRIX_RUNS     Per-model runs from 1 through 100 (default: 10)`);
}

async function main() {
  if (process.argv.includes('--help')) {
    printHelp();
    return;
  }
  try {
    const config = createLiveToolMatrixConfig(process.env);
    const result = await runLiveToolMatrix(config);
    printResult(result);
    process.exitCode = result.passed === result.total ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Unknown live matrix failure');
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  await main();
}
