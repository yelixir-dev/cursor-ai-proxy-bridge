import { describe, expect, it } from 'vitest';
import {
  createLiveToolMatrixConfig,
  LIVE_TOOL_MATRIX_MODELS,
  runLiveToolMatrix,
} from '../scripts/live-tool-matrix.mjs';

describe('opt-in live tool matrix', () => {
  it('requires an explicit opt-in before constructing live configuration', () => {
    // Given: endpoint credentials without the live quota opt-in.
    const env = {
      CURSOR_TOOL_MATRIX_BASE_URL: 'http://127.0.0.1:4000',
      CURSOR_TOOL_MATRIX_API_KEY: 'test-key',
    };

    // When/Then: configuration fails before any request can run.
    expect(() => createLiveToolMatrixConfig(env)).toThrow('CURSOR_TOOL_MATRIX_LIVE=1 is required');
  });

  it('defaults to ten runs for every supported Cursor model', () => {
    // Given: the minimum explicit live configuration.
    const env = {
      CURSOR_TOOL_MATRIX_LIVE: '1',
      CURSOR_TOOL_MATRIX_BASE_URL: 'http://127.0.0.1:4000',
      CURSOR_TOOL_MATRIX_API_KEY: 'test-key',
    };

    // When: the live configuration is parsed.
    const config = createLiveToolMatrixConfig(env);

    // Then: the full model matrix and ten-run quota are fixed.
    expect(config.runs).toBe(10);
    expect(config.models).toEqual(LIVE_TOOL_MATRIX_MODELS);
    expect(config.models).toEqual([
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
  });

  it('counts only exact single read_file responses as passes', async () => {
    // Given: two models, two runs, and one response with an extra tool call.
    const calls = [];
    const config = {
      baseUrl: 'http://127.0.0.1:4000',
      apiKey: 'test-key',
      models: ['model-a', 'model-b'],
      runs: 2,
    };

    // When: the matrix executes through an in-memory completion requester.
    const result = await runLiveToolMatrix(config, async (request) => {
      calls.push(request.model);
      const toolCalls =
        request.model === 'model-b' && calls.length === 4
          ? [{ function: { name: 'read_file' } }, { function: { name: 'ls' } }]
          : [{ function: { name: 'read_file' } }];
      return {
        status: 200,
        body: { choices: [{ message: { tool_calls: toolCalls } }] },
      };
    });

    // Then: every planned request ran, but the extra call failed its trial.
    expect(calls).toEqual(['model-a', 'model-a', 'model-b', 'model-b']);
    expect(result.total).toBe(4);
    expect(result.passed).toBe(3);
    expect(result.rows).toEqual([
      { model: 'model-a', passed: 2, total: 2 },
      { model: 'model-b', passed: 1, total: 2 },
    ]);
  });
});
