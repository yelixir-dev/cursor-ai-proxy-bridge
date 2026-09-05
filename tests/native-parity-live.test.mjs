/* global AbortSignal, Buffer, process */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { once } from 'node:events';
import {
  bounded,
  createSseParser,
  lifecycleMonitor,
  nativeText,
  parseArgs,
  runBridgeTurn,
  runNative,
  stopChild,
  validateCase,
} from '../scripts/native-parity-live.mjs';
import { createToolState, executeTool, toolsFor } from '../scripts/native-parity-mcp.mjs';

describe('native parity contract', () => {
  it('requires successful post-cancel recovery when validating the bridge lane', () => {
    const result = { calls: [], text: '1', cancelled: true, upstreamClosedBeforeCleanup: true };
    expect(validateCase('cancel', result, { requireRecovery: true }).ok).toBe(false);
    expect(
      validateCase('cancel', { ...result, recovery: { ok: false } }, { requireRecovery: true }).ok,
    ).toBe(false);
    expect(
      validateCase('cancel', { ...result, recovery: { ok: true } }, { requireRecovery: true }).ok,
    ).toBe(true);
  });
  it('requires a known case and private evidence destination', () => {
    expect(parseArgs(['--case', 'chat', '--evidence-dir', '/tmp/qa']).caseId).toBe('chat');
    expect(() => parseArgs(['--case', 'unknown', '--evidence-dir', '/tmp/qa'])).toThrow();
    expect(() => parseArgs(['--case', 'chat'])).toThrow();
  });
  it('parses fragmented CRLF SSE, multiline data, comments and DONE', () => {
    const seen = [];
    const parser = createSseParser((v) => seen.push(v));
    for (const part of [
      ': ping\r',
      '\n\r\ndata: {"choices":\r\n',
      'data: []}\r\n\r\ndata: [DO',
      'NE]\r\n\r\n',
    ])
      parser.push(part);
    parser.finish();
    expect(seen).toEqual([{ choices: [] }, '[DONE]']);
    expect(() => {
      const p = createSseParser(() => {});
      p.push('data: {');
      p.finish();
    }).toThrow();
  });
  it('cancels only actual text, never status, thinking, empty content or tools', () => {
    for (const event of [
      { type: 'system' },
      { type: 'tool_call' },
      { type: 'thinking' },
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'x' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: '' }] } },
    ])
      expect(nativeText(event)).toBe('');
    expect(
      nativeText({ type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } }),
    ).toBe('x');
  });
  it('requires two dependent sequential calls and rejects guessed or replayed arguments', () => {
    const state = createToolState('sequential', 'hidden-next');
    expect(() => executeTool(state, 'finish_code', { code: 'hidden-next' })).toThrow();
    const first = executeTool(state, 'lookup_code', { key: 'ALPHA' });
    expect(first.content[0].text).toBe('hidden-next');
    expect(() => executeTool(state, 'finish_code', { code: 'wrong' })).toThrow();
    executeTool(state, 'finish_code', { code: first.content[0].text });
    expect(
      validateCase('sequential', { calls: state.calls, text: 'DONE', terminal: true }).ok,
    ).toBe(true);
    expect(
      validateCase('sequential', { calls: state.calls.slice(0, 1), text: 'DONE', terminal: true })
        .ok,
    ).toBe(false);
  });
  it('checks parallel arguments as a multiset and never accepts just captured traffic', () => {
    const state = createToolState('parallel', 'unused');
    executeTool(state, 'echo_value', { value: 'WIRE_B' });
    executeTool(state, 'echo_value', { value: 'WIRE_A' });
    expect(validateCase('parallel', { calls: state.calls, text: 'DONE', terminal: true }).ok).toBe(
      true,
    );
    expect(
      validateCase('parallel', {
        calls: [state.calls[0], state.calls[0]],
        text: 'DONE',
        terminal: true,
      }).ok,
    ).toBe(false);
    expect(validateCase('chat', { calls: [], text: 'WIRE_OK', terminal: false }).ok).toBe(false);
    expect(
      validateCase('cancel', {
        calls: [],
        text: 'x',
        cancelled: true,
        upstreamClosedBeforeCleanup: false,
      }).ok,
    ).toBe(false);
  });
});

describe('MCP and cancellation lifecycle', () => {
  it.each([
    ['bridge', 'echo_value', false],
    ['bridge', undefined, false],
    ['other-server', 'echo_value', true],
    ['bridge', 'undeclared', true],
  ])(
    'uses the final assistant phase and validates schema lookup %s/%s',
    async (server, toolName, unexpected) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-parity-final-'));
      const cli = path.join(dir, 'fake-cli.mjs');
      const assistant = (text, metadata = {}) => ({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text }] },
        ...metadata,
      });
      const events = [
        assistant('Calling ', { timestamp_ms: 1 }),
        assistant('Calling tools.', { timestamp_ms: 2, model_call_id: 'initial' }),
        {
          type: 'tool_call',
          subtype: 'started',
          call_id: 'schema',
          tool_call: { getMcpToolsToolCall: { args: { server, toolName } } },
        },
        { type: 'tool_call', subtype: 'started', call_id: 'a', tool_call: { mcpToolCall: {} } },
        { type: 'tool_call', subtype: 'started', call_id: 'b', tool_call: { mcpToolCall: {} } },
        assistant('DO', { timestamp_ms: 3 }),
        assistant('NE', { timestamp_ms: 4 }),
        assistant('DONE'),
        { type: 'result', subtype: 'success', is_error: false, result: 'Calling tools.\nDONE' },
      ];
      fs.writeFileSync(
        cli,
        '#!' +
          process.execPath +
          '\nprocess.stdin.resume(); process.stdin.on("end", () => { for (const event of ' +
          JSON.stringify(events) +
          ') process.stdout.write(JSON.stringify(event) + "\\n"); });\n',
        { mode: 0o700 },
      );
      const receipts = [];
      try {
        const result = await runNative({
          cli,
          workspace: dir,
          laneDir: dir,
          env: { PATH: process.env.PATH },
          caseId: 'parallel',
          prompt: 'same-input',
          api: 'https://127.0.0.1:1',
          agent: 'https://127.0.0.1:2',
          monitor: {},
          receipts,
          signal: AbortSignal.timeout(5000),
        });
        expect(result.terminal).toBe(true);
        expect(result.text).toBe('DONE');
        expect(result.nativeTools.filter((tool) => tool.mcpToolCall)).toHaveLength(2);
        expect(result.unexpectedNativeTools).toBe(unexpected);
        expect(receipts.every((receipt) => receipt.ok)).toBe(true);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('observes termination of an orphan descendant before accepting cleanup', async () => {
    const descendantSource =
      "process.on('SIGTERM', () => {}); require('node:net').createServer().listen(0, '127.0.0.1', () => process.send('ready'));";
    const child = spawn(
      process.execPath,
      [
        '-e',
        "const {spawn} = require('node:child_process'); const c = spawn(process.execPath, ['-e', " +
          JSON.stringify(descendantSource) +
          "], {stdio:['ignore','ignore','ignore','ipc']}); c.once('message', () => { process.send(c.pid); c.disconnect(); process.exit(0); });",
      ],
      { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
    );
    const closed = once(child, 'close').then(([code, signal]) => ({ code, signal }));
    const ready = once(child, 'message');
    const receipts = [];
    const forceCleanup = () => {
      execFileSync('python3', ['scripts/native-parity-process-exit.py', String(child.pid)]);
    };
    try {
      const [descendantPid] = await bounded(ready, 5000, 'descendant_ready_timeout');
      await bounded(closed, 5000, 'parent_close_timeout');
      await stopChild({ child, closed }, 'synthetic-orphan', receipts);
      expect(receipts).toEqual([
        {
          role: 'synthetic-orphan',
          pid: child.pid,
          escalated: true,
          ok: true,
          exit: { code: 0, signal: null },
          groupExit: { observedPids: [descendantPid], remainingPids: [] },
        },
      ]);
      const members = execFileSync('ps', ['-axo', 'pid=,pgid=,stat='], { encoding: 'utf8' })
        .trim()
        .split('\n')
        .map((line) => line.trim().split(/\s+/))
        .filter(([, group, state]) => Number(group) === child.pid && !state.startsWith('Z'));
      expect(members).toEqual([]);
    } finally {
      forceCleanup();
      await bounded(closed, 5000, 'cleanup_timeout');
    }
  });
  it('escalates a parent that ignores SIGTERM and observes its exit', async () => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        "process.on('SIGTERM', () => {}); require('node:net').createServer().listen(0, '127.0.0.1', () => process.send('ready'));",
      ],
      { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
    );
    const closed = once(child, 'close').then(([code, signal]) => ({ code, signal }));
    const ready = once(child, 'message');
    try {
      await bounded(ready, 5000, 'parent_ready_timeout');
      const receipts = [];
      await stopChild({ child, closed }, 'synthetic-stubborn-parent', receipts);
      expect(receipts).toEqual([
        {
          role: 'synthetic-stubborn-parent',
          pid: child.pid,
          escalated: true,
          ok: true,
          exit: { code: null, signal: 'SIGKILL' },
          groupExit: { observedPids: [child.pid], remainingPids: [] },
        },
      ]);
    } finally {
      child.kill('SIGKILL');
      await bounded(closed, 5000, 'cleanup_timeout');
    }
  }, 10000);
  it('reports genuinely surviving members when a kill does not terminate them', async () => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        "require('node:net').createServer().listen(0, '127.0.0.1', () => process.send('ready'));",
      ],
      { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
    );
    const closed = once(child, 'close');
    const ready = once(child, 'message');
    let observer;
    let observerClosed;
    try {
      await bounded(ready, 5000, 'parent_ready_timeout');
      // Suppress only delivery, retaining real membership and kernel exit subscriptions.
      observer = spawn(
        'python3',
        [
          '-c',
          'import importlib.util,json,sys; from unittest.mock import patch; ' +
            "spec=importlib.util.spec_from_file_location('observer', 'scripts/native-parity-process-exit.py'); " +
            'm=importlib.util.module_from_spec(spec); spec.loader.exec_module(m); ' +
            "p=patch.object(m.os, 'killpg'); kill=p.start(); result=m.terminate(int(sys.argv[1])); " +
            'kill.assert_called_once_with(int(sys.argv[1]), m.signal.SIGKILL); print(json.dumps(result))',
          String(child.pid),
        ],
        {
          stdio: ['ignore', 'pipe', 'inherit'],
          env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
        },
      );
      let output = '';
      observer.stdout.on('data', (chunk) => {
        output += chunk;
      });
      observerClosed = once(observer, 'close');
      expect(await bounded(observerClosed, 5000, 'observer_timeout')).toEqual([0, null]);
      expect(JSON.parse(output)).toEqual({ observedPids: [child.pid], remainingPids: [child.pid] });
    } finally {
      observer?.kill('SIGKILL');
      if (observerClosed) await bounded(observerClosed, 5000, 'observer_cleanup_timeout');
      child.kill('SIGKILL');
      await bounded(closed, 5000, 'cleanup_timeout');
    }
  }, 10000);
  it('supervises a real subprocess and signals it only after an actual native text event', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-parity-child-'));
    const cli = path.join(dir, 'fake-cli.mjs');
    fs.writeFileSync(
      cli,
      `#!${process.execPath}\nimport net from 'node:net';\nimport fs from 'node:fs';\nconst keeper = net.createServer();\nprocess.once('SIGTERM', () => keeper.close(() => process.exit(0)));\nlet prompt = '';\nprocess.stdin.on('data', c => prompt += c);\nprocess.stdin.on('end', () => keeper.listen(0, '127.0.0.1', () => {\nfs.writeFileSync(${JSON.stringify(path.join(dir, 'argv.json'))}, JSON.stringify({ args: process.argv.slice(2), prompt }));\nfor (const event of [{type:'system'}, {type:'assistant',message:{content:[]}}, {type:'assistant',message:{content:[{type:'text',text:'first'}]}}]) process.stdout.write(JSON.stringify(event)+'\\n');\n}));\n`,
      { mode: 0o700 },
    );
    const receipts = [];
    let triggers = 0;
    try {
      const result = await runNative({
        cli,
        workspace: dir,
        laneDir: dir,
        env: { PATH: process.env.PATH },
        caseId: 'cancel',
        prompt: 'same-input',
        api: 'https://127.0.0.1:1',
        agent: 'https://127.0.0.1:2',
        receipts,
        signal: AbortSignal.timeout(5000),
        monitor: {
          cancel: () => {
            triggers++;
          },
          waitForCancelledClose: async () => triggers === 1,
        },
      });
      expect(triggers).toBe(1);
      expect(validateCase('cancel', result).ok).toBe(true);
      expect(receipts.map((receipt) => receipt.ok)).toEqual([true]);
      const invocation = JSON.parse(fs.readFileSync(path.join(dir, 'argv.json'), 'utf8'));
      expect(invocation.prompt).toBe('same-input');
      expect(invocation.args).toContain('--stream-partial-output');
      expect(invocation.args).not.toContain('--auth-token');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it('serves the actual MCP subprocess and records dependent calls and process closure', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-parity-mcp-'));
    const audit = path.join(dir, 'audit.jsonl');
    const child = spawn(process.execPath, ['scripts/native-parity-mcp.mjs'], {
      env: {
        PATH: process.env.PATH,
        NATIVE_PARITY_CASE: 'sequential',
        NATIVE_PARITY_NEXT_CODE: 'opaque-next',
        NATIVE_PARITY_MCP_AUDIT: audit,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const closed = once(child, 'close');
    const lines = createInterface({ input: child.stdout });
    const iterator = lines[Symbol.asyncIterator]();
    const request = async (id, method, params = {}) => {
      const response = iterator.next();
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      const next = await bounded(response, 5000, 'mcp_response_timeout');
      return JSON.parse(next.value);
    };
    try {
      expect(
        (await request(1, 'initialize', { protocolVersion: '2024-11-05' })).result.capabilities,
      ).toEqual({ tools: {} });
      expect((await request(2, 'tools/list')).result.tools).toEqual(toolsFor('sequential'));
      const first = await request(3, 'tools/call', {
        name: 'lookup_code',
        arguments: { key: 'ALPHA' },
      });
      expect(
        (
          await request(4, 'tools/call', {
            name: 'finish_code',
            arguments: { code: first.result.content[0].text },
          })
        ).result.content[0].text,
      ).toBe('DONE');
      child.stdin.end();
      expect(await bounded(closed, 5000, 'mcp_close_timeout')).toEqual([0, null]);
      const events = fs.readFileSync(audit, 'utf8').trim().split('\n').map(JSON.parse);
      expect(events.map((event) => event.event)).toEqual(['started', 'call', 'call', 'closed']);
    } finally {
      child.kill('SIGKILL');
      await bounded(closed, 5000, 'cleanup_timeout');
      lines.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it('requires the attributable upstream close after the trigger, not downstream close alone', async () => {
    const monitor = lifecycleMonitor();
    monitor.record({
      conn: 'conn-1',
      stream: 1,
      event: 'open',
      detail: { path: '/agent.v1.AgentService/Run' },
    });
    monitor.record({ conn: 'other', stream: 1, event: 'upstream_close' });
    monitor.cancel();
    let settled = false;
    const closed = monitor.waitForCancelledClose(AbortSignal.timeout(5000)).then((value) => {
      settled = true;
      return value;
    });
    monitor.record({ conn: 'conn-1', stream: 1, event: 'close' });
    await Promise.resolve();
    expect(settled).toBe(false);
    monitor.record({ conn: 'conn-1', stream: 1, event: 'upstream_close' });
    expect(await closed).toBe(true);
  });
});

describe('bridge SSE real HTTP surface', () => {
  it('assembles interleaved fragmented tool arguments, returns every result and continues history', async () => {
    const http = [];
    const requests = [];
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (delta, finish_reason = null) =>
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      if (requests.length === 1) {
        send({
          tool_calls: [
            {
              index: 1,
              id: 'b',
              type: 'function',
              function: { name: 'echo_value', arguments: '{"value":' },
            },
            {
              index: 0,
              id: 'a',
              type: 'function',
              function: { name: 'echo_value', arguments: '{"value":' },
            },
          ],
        });
        send({
          tool_calls: [
            { index: 0, function: { arguments: '"WIRE_A"}' } },
            { index: 1, function: { arguments: '"WIRE_B"}' } },
          ],
        });
        send({}, 'tool_calls');
      } else {
        send({ content: 'DONE' });
        send({}, 'stop');
      }
      res.end('data: [DONE]\n\n');
    });
    const listening = once(server, 'listening');
    server.listen(0, '127.0.0.1');
    await listening;
    try {
      const result = await runBridgeTurn({
        url: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
        caseId: 'parallel',
        prompt: 'fixture',
        state: createToolState('parallel', 'unused'),
        signal: AbortSignal.timeout(5000),
        onHttp: (event) => http.push(event),
      });
      expect(validateCase('parallel', result).ok).toBe(true);
      expect(requests).toHaveLength(2);
      expect(
        http
          .filter((event) => event.type === 'response')
          .map((event) => [event.status, event.headers['content-type']]),
      ).toEqual([
        [200, 'text/event-stream'],
        [200, 'text/event-stream'],
      ]);
      expect(
        http
          .filter((event) => event.type === 'data')
          .map((event) => event.text)
          .join(''),
      ).toContain('data: [DONE]');
      expect(requests[0].tools.map((t) => t.function.parameters)).toEqual(
        toolsFor('parallel').map((t) => t.inputSchema),
      );
      expect(requests[1].messages.slice(-2)).toEqual([
        { role: 'tool', tool_call_id: 'a', content: 'WIRE_A' },
        { role: 'tool', tool_call_id: 'b', content: 'WIRE_B' },
      ]);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
  it('aborts an open response on text but not the initial role event', async () => {
    let closed;
    const responseClosed = new Promise((resolve) => {
      closed = resolve;
    });
    const server = createServer((_req, res) => {
      res.once('close', closed);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"first"}}]}\n\n');
    });
    const listening = once(server, 'listening');
    server.listen(0, '127.0.0.1');
    await listening;
    try {
      const result = await runBridgeTurn({
        url: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
        caseId: 'cancel',
        prompt: 'fixture',
        state: createToolState('cancel', 'unused'),
        signal: AbortSignal.timeout(5000),
      });
      expect(result.cancelled).toBe(true);
      expect(result.text).toBe('first');
      await bounded(responseClosed, 5000, 'response_close_timeout');
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
