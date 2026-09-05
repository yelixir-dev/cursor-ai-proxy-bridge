/* global process, TextDecoder */
import fs from 'node:fs';
import path from 'node:path';
import { DEADLINE, readLines } from './shared.mjs';
import { alive, bounded, signalGroup, stopChild, trackedChild } from './processes.mjs';
import { toolsFor } from '../native-parity-mcp.mjs';

export function nativeText(event) {
  if (event.type !== 'assistant') return '';
  return (event.message?.content ?? [])
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

export async function runNative({
  cli,
  workspace,
  laneDir,
  env,
  caseId,
  prompt,
  api,
  agent,
  monitor,
  receipts,
  signal,
}) {
  const stdoutFile = path.join(laneDir, 'native.stdout.jsonl');
  const stderr = fs.openSync(path.join(laneDir, 'native.stderr.log'), 'w', 0o600);
  let resource;
  let cancelled = false;
  let terminal = false;
  let text = '';
  let sawAssistant = false;
  let errorCode;
  let pending = '';
  const decoder = new TextDecoder();
  const nativeTools = [];
  const seen = new Set();
  try {
    resource = trackedChild(
      cli,
      [
        '--print',
        '--output-format',
        'stream-json',
        '--stream-partial-output',
        '--trust',
        '--yolo',
        '--approve-mcps',
        '--endpoint',
        api,
        '--agent-endpoint',
        agent,
        '--model',
        'composer-2.5',
      ],
      { cwd: workspace, env, stdio: ['pipe', 'pipe', stderr] },
    );
    const event = (value) => {
      const delta = nativeText(value);
      if (delta) {
        sawAssistant = true;
        if (value.model_call_id !== undefined || value.timestamp_ms === undefined) text = delta;
        else text += delta;
        if (caseId === 'cancel' && !cancelled) {
          cancelled = true;
          monitor.cancel();
          signalGroup(resource.child, 'SIGTERM');
        }
      }
      if (value.type === 'tool_call' && value.subtype === 'started' && !seen.has(value.call_id)) {
        text = '';
        seen.add(value.call_id);
        nativeTools.push(value.tool_call);
      }
      if (value.type === 'result') {
        terminal = value.subtype === 'success' && value.is_error === false;
        if (!sawAssistant && typeof value.result === 'string') text = value.result;
      }
    };
    resource.child.stdout.on('data', (chunk) => {
      fs.appendFileSync(stdoutFile, chunk, { mode: 0o600 });
      if (errorCode) return;
      try {
        pending += decoder.decode(chunk, { stream: true });
        if (pending.length > 4 * 1024 * 1024) throw new Error('native_line_limit');
        const lines = pending.split('\n');
        pending = lines.pop();
        for (const line of lines) if (line.trim()) event(JSON.parse(line));
      } catch {
        errorCode = 'native_jsonl_invalid';
        signalGroup(resource.child, 'SIGTERM');
      }
    });
    resource.child.stdin.on('error', () => {
      errorCode ??= 'native_stdin_error';
    });
    resource.child.stdin.end(prompt);
    const exit = await bounded(resource.closed, DEADLINE, 'native_timeout', signal);
    pending += decoder.decode();
    if (pending.trim()) {
      try {
        event(JSON.parse(pending));
      } catch {
        errorCode = 'native_jsonl_invalid';
      }
    }
    const upstreamClosedBeforeCleanup = cancelled
      ? await monitor.waitForCancelledClose(signal)
      : false;
    const audit = readLines(path.join(laneDir, 'mcp-audit.jsonl'));
    const calls = audit
      .filter((entry) => entry.event === 'call')
      .map(({ name, args, result }) => ({ name, args, result }));
    const toolErrors = audit.some((entry) => entry.event === 'tool_error');
    const unexpectedNativeTools = nativeTools.some((tool) => {
      if (tool.mcpToolCall) return false;
      const lookup = tool.getMcpToolsToolCall?.args;
      return (
        lookup?.server !== 'bridge' ||
        toolsFor(caseId).length === 0 ||
        (lookup.toolName !== undefined &&
          !toolsFor(caseId).some((declared) => declared.name === lookup.toolName))
      );
    });
    return {
      text,
      unexpectedNativeTools,
      terminal: terminal && exit.code === 0 && !errorCode,
      cancelled,
      upstreamClosedBeforeCleanup,
      calls,
      toolErrors,
      nativeTools,
      exit,
      errorCode: errorCode ?? null,
    };
  } finally {
    try {
      if (resource) await stopChild(resource, 'native-cli', receipts);
    } finally {
      fs.closeSync(stderr);
      for (const entry of readLines(path.join(laneDir, 'mcp-audit.jsonl')).filter(
        (entry) => entry.event === 'started',
      )) {
        const remaining = alive(entry.pid);
        const receipt = { role: 'native-mcp', pid: entry.pid, ok: !remaining };
        receipts.push(receipt);
        if (remaining) {
          process.kill(entry.pid, 'SIGKILL');
          receipt.error = 'mcp_outlived_cli';
        }
      }
    }
  }
}
