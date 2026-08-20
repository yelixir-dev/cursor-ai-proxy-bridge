import type { BridgeConfig } from '../config.js';
import { cursorCliArgs } from './cursor-cli-command.js';
import { CursorBackendError } from './cursor-cli-errors.js';
import {
  choiceRequiresToolCall,
  parseCursorToolCallOutput,
  promptFromMessages,
  toolValidationFeedback,
} from './cursor-cli-prompt.js';
import type { CursorCommandRunner } from './cursor-cli-process.js';
import { completionFromCapturedTools, parseCursorResult } from './cursor-cli-result.js';
import { cursorCompletionEvents } from './cursor-cli-stream.js';
import { acquireWorkspaceMutex, createCursorWorkspace } from './cursor-cli-workspace.js';
import { ToolArgumentValidationError, validateToolCallArguments } from './tool-arguments.js';
import type {
  ChatCompletionRequest,
  CompletionResult,
  CompletionStreamEvent,
  CompletionUsage,
  ToolCall,
  UsageSource,
} from './types.js';

export type CursorCliCompletionContext = {
  readonly config: BridgeConfig;
  readonly executeCommand: CursorCommandRunner;
  readonly cursorBin: string;
  readonly timeoutMs: number;
};

type CollectedStream = {
  readonly text: string;
  readonly usage: CompletionUsage;
  readonly usageSource: UsageSource;
};

export async function* completeCursorStream(
  context: CursorCliCompletionContext,
  request: ChatCompletionRequest,
  signal?: AbortSignal,
): AsyncIterable<CompletionStreamEvent> {
  const workspace = await createCursorWorkspace(context.config);
  let releaseWorkspace: (() => void) | undefined;
  try {
    if (context.config.workspaceMode === 'real-workspace') {
      releaseWorkspace = await acquireWorkspaceMutex(workspace.cwd, signal);
    }
    const prompt = promptFromMessages(request);
    const args = cursorCliArgs({
      cursorBin: context.cursorBin,
      request,
      workspacePath: workspace.cwd,
      workspaceMode: context.config.workspaceMode,
      streaming: true,
    });
    const stream = (streamPrompt: string) =>
      cursorCompletionEvents({
        execute: context.executeCommand,
        command: context.cursorBin,
        args,
        cwd: workspace.cwd,
        timeoutMs: context.timeoutMs,
        prompt: streamPrompt,
        signal,
      });

    if (!request.tools || request.tools.length === 0) {
      for await (const event of stream(prompt)) yield event;
      return;
    }

    const collect = async (streamPrompt: string): Promise<CollectedStream> => {
      let text = '';
      let usage: CompletionUsage | undefined;
      let usageSource: UsageSource = 'unknown';
      for await (const event of stream(streamPrompt)) {
        switch (event.type) {
          case 'content':
            text += event.text;
            break;
          case 'done':
            if (event.is_error) {
              throw new CursorBackendError(event.message ?? 'Cursor returned an error');
            }
            usage = event.usage;
            usageSource = event.usage_source ?? 'unknown';
            break;
          case 'thinking':
          case 'tool_call_start':
          case 'tool_call_arguments_delta':
          case 'tool_call_complete':
            break;
          default:
            event satisfies never;
        }
      }
      if (!usage) throw new CursorBackendError('Cursor stream ended without usage');
      return { text, usage, usageSource };
    };

    let output = await collect(prompt);
    if (request.tool_choice !== 'none') {
      const calls = parseCursorToolCallOutput(output.text, request);
      if (calls.length > 0) {
        const failure = validateToolCallArguments(calls, request.tools);
        if (failure) {
          const retryPrompt = prompt + toolValidationFeedback(failure);
          output = await collect(retryPrompt);
          const retryCalls = parseCursorToolCallOutput(output.text, request);
          if (retryCalls.length === 0) {
            throw new ToolArgumentValidationError({
              toolName: failure.toolName,
              message: `${failure.message}; retry did not return a corrected tool call`,
            });
          }
          const retryFailure = validateToolCallArguments(retryCalls, request.tools);
          if (retryFailure) throw new ToolArgumentValidationError(retryFailure);
        }
      } else if (choiceRequiresToolCall(request)) {
        throw new Error('Cursor did not return the required tool call');
      }
    }
    if (output.text) yield { type: 'content', text: output.text };
    yield {
      type: 'done',
      usage: output.usage,
      usage_source: output.usageSource,
      is_error: false,
    };
  } finally {
    releaseWorkspace?.();
    await workspace.cleanup();
  }
}

export async function completeCursor(
  context: CursorCliCompletionContext,
  request: ChatCompletionRequest,
  signal?: AbortSignal,
): Promise<CompletionResult> {
  const workspace = await createCursorWorkspace(context.config);
  let releaseWorkspace: (() => void) | undefined;
  try {
    if (context.config.workspaceMode === 'real-workspace') {
      releaseWorkspace = await acquireWorkspaceMutex(workspace.cwd, signal);
    }
    const prompt = promptFromMessages(request);
    const args = cursorCliArgs({
      cursorBin: context.cursorBin,
      request,
      workspacePath: workspace.cwd,
      workspaceMode: context.config.workspaceMode,
    });

    const validateAndComplete = async (
      toolCalls: ToolCall[],
      usage: CompletionUsage,
      usageSource: UsageSource,
    ): Promise<CompletionResult | undefined> => {
      if (toolCalls.length === 0) return undefined;
      const failure = validateToolCallArguments(toolCalls, request.tools);
      if (!failure) {
        return completionFromCapturedTools({ request, toolCalls, usage, usageSource });
      }

      const retryPrompt = prompt + toolValidationFeedback(failure);
      const retryRawOutput = await context.executeCommand(
        context.cursorBin,
        args,
        workspace.cwd,
        context.timeoutMs,
        retryPrompt,
        signal,
      );
      const retryOutput = parseCursorResult(retryRawOutput, retryPrompt);
      const retryCalls = parseCursorToolCallOutput(retryOutput.text, request);
      if (retryCalls.length === 0) {
        throw new ToolArgumentValidationError({
          toolName: failure.toolName,
          message: `${failure.message}; retry did not return a corrected tool call`,
        });
      }
      const retryFailure = validateToolCallArguments(retryCalls, request.tools);
      if (retryFailure) throw new ToolArgumentValidationError(retryFailure);
      return completionFromCapturedTools({
        request,
        toolCalls: retryCalls,
        usage: retryOutput.usage,
        usageSource: retryOutput.usageSource,
      });
    };

    const rawOutput = await context.executeCommand(
      context.cursorBin,
      args,
      workspace.cwd,
      context.timeoutMs,
      prompt,
      signal,
    );
    const output = parseCursorResult(rawOutput, prompt);
    if (request.tool_choice !== 'none') {
      const toolCompletion = await validateAndComplete(
        parseCursorToolCallOutput(output.text, request),
        output.usage,
        output.usageSource,
      );
      if (toolCompletion) return toolCompletion;
      if (choiceRequiresToolCall(request)) {
        throw new Error('Cursor did not return the required tool call');
      }
    }
    return {
      content: output.text || null,
      model: request.model,
      usage: output.usage,
      usage_source: output.usageSource,
    };
  } finally {
    releaseWorkspace?.();
    await workspace.cleanup();
  }
}
