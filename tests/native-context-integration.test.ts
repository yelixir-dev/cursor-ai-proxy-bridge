import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CursorApiDiscovery } from '../src/backend/cursor-api/discovery.js';
import { createCursorApiRuntime } from '../src/backend/cursor-api/runtime.js';
import { buildServer } from '../src/server.js';
import { update } from './support/cursor-api-scripted.js';
import { managedContextBody, nativeContextResponse } from './support/native-context-fixture.js';
import {
  account,
  config,
  request,
  managedPath,
  pluginPath,
  bounded,
  cleanup,
  object,
  decoded,
  exec,
  reply,
  onReply,
  finish,
  fixture,
} from './support/native-context-integration-fixture.js';

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

describe('native account context integration', () => {
  it.each([false, true])(
    'encodes full selected-account context through real loopback HTTP (stream=%s)',
    async (streaming) => {
      const f = fixture();
      const server = await buildServer({ config, backend: f.backend });
      cleanup.push(() => server.close());
      await server.listen({ host: '127.0.0.1', port: 0 });
      const address = server.server.address();
      assert.ok(address && typeof address !== 'string');
      const pending = fetch('http://127.0.0.1:' + address.port + '/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...request, stream: streaming }),
        signal: AbortSignal.timeout(3_000),
      });
      const stream = await bounded(f.opened);
      const read = onReply(stream, 'readResult');
      exec(stream, 'readArgs', { path: managedPath, offset: 5, limit: 2 });
      const readReply = await read;
      expect(object(object(object(readReply.message).value).result).value).toMatchObject({
        output: { case: 'content', value: 'ONE\nTWO' },
        rangeApplied: true,
      });
      finish(stream);
      const response = await pending;
      const body = await response.text();
      await server.close();
      if (process.env.NATIVE_CONTEXT_EVIDENCE === '1')
        process.stdout.write(
          'CONTEXT_HTTP_RECEIPT ' +
            JSON.stringify({
              request: {
                method: 'POST',
                url: 'http://127.0.0.1:' + address.port + '/v1/chat/completions',
                headers: { 'content-type': 'application/json' },
                body: { ...request, stream: streaming },
              },
              status: response.status,
              headers: Object.fromEntries(response.headers),
              body,
              upstream: decoded(stream),
              upstreamWireBase64: stream.writes.map((chunk) => chunk.toString('base64')),
              cleanup: {
                listening: server.server.listening,
                openStreams: f.streams.filter((s) => !s.destroyed && !s.writableEnded).length,
                transportStopped: f.transportStopped(),
              },
            }) +
            '\n',
        );
      expect(response.status).toBe(200);
      if (streaming) {
        expect(response.headers.get('content-type')).toContain('text/event-stream');
        expect(body).toContain('"content":"CONTEXT_OK"');
        expect(body).toContain('data: [DONE]');
      } else {
        expect(response.headers.get('content-type')).toContain('application/json');
        expect(object(JSON.parse(body)).choices).toMatchObject([
          { message: { content: 'CONTEXT_OK' }, finish_reason: 'stop' },
        ]);
      }
      const context = object(
        object(object(object(reply(stream, 'requestContextResult')?.message).value).result).value,
      ).requestContext;
      expect(context).toMatchObject({
        repositoryInfo: [
          { repoOwner: 'auth|A', pathEncryptionKey: Buffer.alloc(32, 1).toString('base64url') },
        ],
        hooksConfig: {},
        commitAttributionMessage: 'enabled',
        prAttributionMessage: 'enabled',
        agentSkills: [
          { fullPath: managedPath },
          { plugin: 'fixture-plugin', marketplace: 'fixture-market' },
        ],
        customSubagents: [{ name: 'worker', prompt: 'WORKER_PROMPT', model: 'inherit' }],
      });
      const env = object(object(context).env);
      const run = object(object(decoded(stream)[0]?.message).value);
      expect(env.agentConversationNotesFolder).toBe(
        env.projectFolder + '/agent-notes/' + String(run.conversationId),
      );
      expect(env.workspacePaths).toEqual([process.cwd()]);
      expect(env.projectFolder).toMatch(/^\/isolated\/context-data\/projects\//);
      expect(f.calls.filter((call) => call.method === 'GetManagedSkills')).toMatchObject([
        { token: 'A', bootstrap: false },
      ]);
    },
  );

  it.each([
    [{ offset: 5, limit: 2 }, 'ONE\nTWO', true],
    [{ offset: -3 }, 'TWO\nTHREE\n', true],
    [{ offset: 500 }, managedContextBody, false],
    [{}, managedContextBody, false],
  ])(
    'answers owned readArgs internally with native slicing %j and a correlated stream close',
    async (range, content, rangeApplied) => {
      const f = fixture();
      const pending = f.backend.complete(request);
      const stream = await bounded(f.opened);
      const received = onReply(stream, 'readResult');
      exec(stream, 'readArgs', { path: managedPath, ...range });
      const result = await received;
      finish(stream);
      await bounded(pending);
      expect(object(object(result.message).value).result).toEqual({
        case: 'success',
        value: {
          path: managedPath,
          output: { case: 'content', value: content },
          totalLines: 8,
          fileSize: Buffer.byteLength(managedContextBody),
          ...(rangeApplied ? { rangeApplied: true } : {}),
        },
      });
      expect(result.execId).toBeUndefined();
      expect(object(decoded(stream).at(-1)?.message)).toMatchObject({
        case: 'execClientControlMessage',
        value: { message: { case: 'streamClose', value: { id: 7 } } },
      });
    },
  );

  it('allows owned read announcements without declaring an external tool', async () => {
    const f = fixture();
    const pending = f.backend.complete(request);
    const assertion = expect(pending).resolves.toMatchObject({ content: 'CONTEXT_OK' });
    const stream = await bounded(f.opened);
    stream.emit(
      'data',
      update('toolCallStarted', {
        callId: 'read-1',
        toolCall: {
          tool: { case: 'readToolCall', value: { args: { path: managedPath } } },
          toolCallId: 'read-1',
        },
      }),
    );
    finish(stream);
    await assertion;
  });

  it('omits the native zero exec id and still closes that exec stream', async () => {
    const f = fixture();
    const pending = f.backend.complete(request);
    const stream = await bounded(f.opened);
    exec(stream, 'requestContextArgs', {}, 0);
    const responses = decoded(stream)
      .map((frame) => object(frame.message))
      .filter((message) => message.case === 'execClientMessage');
    finish(stream);
    await pending;
    expect(object(responses.at(-1)?.value).id).toBeUndefined();
    expect(object(decoded(stream).at(-1)?.message)).toMatchObject({
      case: 'execClientControlMessage',
      value: { message: { case: 'streamClose', value: {} } },
    });
  });

  it('returns the native line count and no applied range for an empty context resource', async () => {
    const f = fixture();
    const pending = f.backend.complete(request);
    const stream = await bounded(f.opened);
    const received = onReply(stream, 'readResult');
    exec(stream, 'readArgs', { path: managedPath.replace('SKILL.md', 'empty.md'), offset: 1 });
    const result = await received;
    finish(stream);
    await pending;
    expect(object(object(object(result.message).value).result).value).toEqual({
      path: managedPath.replace('SKILL.md', 'empty.md'),
      totalLines: 1,
      output: { case: 'content', value: '' },
    });
  });

  it('invalidates pending account metadata without reviving the old generation', async () => {
    const f = fixture();
    const runtime = createCursorApiRuntime(config, f.dependencies);
    const discovery = new CursorApiDiscovery(runtime);
    const gate = Promise.withResolvers<Buffer>();
    const entered = Promise.withResolvers<void>();
    f.gates.set('A:GetManagedSkills', gate);
    f.entered.set('A:GetManagedSkills', entered);
    const old = discovery.prepare(account('A'), 'A').then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await bounded(Promise.race([entered.promise, old]));
    expect(f.calls.some((call) => call.method === 'GetManagedSkills')).toBe(true);
    discovery.invalidateCredentials(['A']);
    f.gates.delete('A:GetManagedSkills');
    const fresh = await bounded(discovery.prepare(account('A'), 'A'));
    gate.resolve(nativeContextResponse('/GetManagedSkills', 'obsolete'));
    expect(await old).toMatchObject({
      error: expect.objectContaining({ name: 'CursorDiscoveryInvalidatedError' }),
    });
    expect(fresh.generation).toBe(1);
    expect(f.calls.filter((call) => call.method === 'GetManagedSkills')).toHaveLength(2);
    expect(
      fresh.nativeContext.forConversation({
        homeDir: homedir(),
        workspacePath: process.cwd(),
        conversationId: 'fresh',
      }).context.agentSkills[0]?.fullPath,
    ).toBe(managedPath);
  });

  it('caches account facts once per selected credential generation without routing again', async () => {
    const f = fixture();
    const runtime = createCursorApiRuntime(config, f.dependencies);
    const discovery = new CursorApiDiscovery(runtime);
    const [a, b, aAgain] = await bounded(
      Promise.all([
        discovery.prepare(account('A'), 'A'),
        discovery.prepare(account('B'), 'B'),
        discovery.prepare(account('A'), 'A'),
      ]),
    );
    const paths = { homeDir: homedir(), workspacePath: process.cwd(), conversationId: 'isolated' };
    const aContext = a.nativeContext.forConversation(paths);
    const bContext = b.nativeContext.forConversation(paths);
    expect(a.nativeContext).toBe(aAgain.nativeContext);
    expect(aContext.context.repositoryInfo[0]?.repoOwner).toBe('auth|A');
    expect(bContext.context.repositoryInfo[0]?.repoOwner).toBe('auth|B');
    expect(bContext.ownsPath(managedPath)).toBe(false);
    expect(aContext.ownsPath(managedPath.replace('fixture-A', 'fixture-B'))).toBe(false);
    expect(bContext.context.repositoryInfo[0]?.pathEncryptionKey).toBe(
      Buffer.alloc(32, 2).toString('base64url'),
    );
    expect(
      f.calls
        .filter((call) => call.method === 'GetManagedSkills')
        .map((call) => call.token)
        .sort(),
    ).toEqual(['A', 'B']);
    expect(runtime.credentialRouter.snapshot().map((state) => state.routerPicks)).toEqual([0, 0]);
  });

  it('lets one metadata waiter cancel without poisoning another waiter in the same generation', async () => {
    const f = fixture();
    const runtime = createCursorApiRuntime(config, f.dependencies);
    const discovery = new CursorApiDiscovery(runtime);
    const gate = Promise.withResolvers<Buffer>();
    const entered = Promise.withResolvers<void>();
    const controller = new AbortController();
    f.gates.set('A:GetManagedSkills', gate);
    f.entered.set('A:GetManagedSkills', entered);
    const first = discovery.prepare(account('A'), 'A', controller.signal).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    const second = discovery.prepare(account('A'), 'A');
    await bounded(entered.promise);
    controller.abort(new Error('caller-cancelled'));
    expect(await first).toMatchObject({
      error: expect.objectContaining({ message: 'caller-cancelled' }),
    });
    gate.resolve(nativeContextResponse('/GetManagedSkills', 'A'));
    expect((await bounded(second)).nativeContext).toBeDefined();
    expect(f.calls.filter((call) => call.method === 'GetManagedSkills')).toHaveLength(1);
  });

  it('retains declared external read policy and sticky reuse without reloading account facts', async () => {
    const f = fixture();
    const initial = {
      ...request,
      max_tool_calls: 1,
      tools: [
        {
          type: 'function' as const,
          function: {
            name: 'read',
            parameters: { type: 'object', properties: { path: { type: 'string' } } },
          },
        },
      ],
    };
    const pending = f.backend.complete(initial);
    const stream = await bounded(f.opened);
    exec(stream, 'readArgs', { path: '/workspace/client-file.md', toolCallId: 'external-read' });
    const result = await bounded(pending);
    expect(result.tool_calls).toMatchObject([
      {
        function: {
          name: 'read',
          arguments: JSON.stringify({ path: '/workspace/client-file.md' }),
        },
      },
    ]);
    expect(reply(stream, 'readResult')).toBeUndefined();
    const call = result.tool_calls?.[0];
    assert.ok(call);
    const received = onReply(stream, 'readResult');
    const resumed = f.backend.complete({
      ...initial,
      messages: [
        ...initial.messages,
        { role: 'assistant', content: '', tool_calls: result.tool_calls },
        { role: 'tool', tool_call_id: call.id, content: 'CLIENT_BODY' },
      ],
    });
    await received;
    finish(stream);
    expect(await bounded(resumed)).toMatchObject({ content: 'CONTEXT_OK' });
    expect(f.streams).toHaveLength(1);
    expect(f.calls.filter((call) => call.method === 'GetManagedSkills')).toHaveLength(1);
  });

  it.each(['caller', 'credential', 'terminal'] as const)(
    'cancels a pending owned source read on %s and does not write its late result',
    async (cause) => {
      const f = fixture();
      const controller = new AbortController();
      const pending = f.backend.complete(request, controller.signal).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      const stream = await bounded(f.opened);
      exec(stream, 'readArgs', { path: pluginPath });
      const fetchSignal = await bounded(f.fetchStarted.promise);
      if (cause === 'caller') controller.abort();
      else if (cause === 'credential') f.backend.updateCredentials([account('B')]);
      else finish(stream);
      if (cause === 'terminal')
        expect(await pending).toMatchObject({ value: { content: 'CONTEXT_OK' } });
      else
        expect(await pending).toMatchObject({
          error: expect.objectContaining({ name: 'AbortError' }),
        });
      expect(fetchSignal.aborted).toBe(true);
      f.fetchFinished.resolve(new Response('LATE_BODY'));
      expect(reply(stream, 'readResult')).toBeUndefined();
    },
  );

  it.each([404, 403, 503, 'network', 'untyped-404'] as const)(
    'replies with a sanitized native read error for owned source failure %s and continues the Run',
    async (failure) => {
      const f = fixture();
      const completed = f.backend.complete(request).then(
        (value) => ({ completion: value }),
        (error) => ({ aborted: error }),
      );
      const stream = await bounded(f.opened);
      const received = onReply(stream, 'readResult').then(
        (value) => ({ reply: value }),
        (error) => ({ replyFailure: error }),
      );
      exec(stream, 'readArgs', { path: pluginPath }, 19);
      await bounded(f.fetchStarted.promise);
      const secret = 'SOURCE_SECRET_DO_NOT_SHIP';
      if (typeof failure === 'number')
        f.fetchFinished.resolve(new Response(secret, { status: failure }));
      else
        f.fetchFinished.reject(
          new Error(
            failure === 'untyped-404' ? 'HTTP 404 ' + secret : 'https://private.invalid/' + secret,
          ),
        );
      const observed = await bounded(Promise.race([received, completed]));
      expect(observed, 'a failed read must reply, not abort the Run').toHaveProperty('reply');
      assert.ok('reply' in observed);
      const result = object(object(object(observed.reply.message).value).result);
      expect(result.case).toBe('error');
      expect(object(result.value).path).toBe(pluginPath);
      expect(typeof object(result.value).error).toBe('string');
      expect(String(object(result.value).error).length).toBeGreaterThan(0);
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(result)).not.toContain('https://');
      expect(observed.reply.id).toBe(19);
      expect(object(decoded(stream).at(-1)?.message)).toMatchObject({
        case: 'execClientControlMessage',
        value: { message: { case: 'streamClose', value: { id: 19 } } },
      });
      finish(stream);
      expect(await bounded(completed)).toMatchObject({ completion: { content: 'CONTEXT_OK' } });
      expect(f.streams).toHaveLength(1);
    },
  );

  it('emits no failed-read reply when its source rejects after cancellation', async () => {
    const f = fixture();
    const controller = new AbortController();
    const completed = f.backend.complete(request, controller.signal).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    const stream = await bounded(f.opened);
    exec(stream, 'readArgs', { path: pluginPath }, 23);
    const sourceSignal = await bounded(f.fetchStarted.promise);
    controller.abort();
    expect(await bounded(completed)).toMatchObject({
      error: expect.objectContaining({ name: 'AbortError' }),
    });
    f.fetchFinished.reject(new Error('LATE_SOURCE_SECRET'));
    await expect(f.fetchFinished.promise).rejects.toThrow('LATE_SOURCE_SECRET');
    expect(sourceSignal.aborted).toBe(true);
    expect(reply(stream, 'readResult')).toBeUndefined();
    expect(
      decoded(stream).filter(
        (message) => object(message.message).case === 'execClientControlMessage',
      ),
    ).toHaveLength(1);
  });

  it('completes real loopback HTTP on the same Run after a failed owned source read', async () => {
    const f = fixture();
    const server = await buildServer({ config, backend: f.backend });
    cleanup.push(() => server.close());
    await server.listen({ host: '127.0.0.1', port: 0 });
    const address = server.server.address();
    assert.ok(address && typeof address !== 'string');
    const url = 'http://127.0.0.1:' + address.port + '/v1/chat/completions';
    const pending = fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(3_000),
    });
    const stream = await bounded(f.opened);
    const received = onReply(stream, 'readResult').then(
      (value) => ({ reply: value }),
      (error) => ({ replyFailure: error }),
    );
    exec(stream, 'readArgs', { path: pluginPath }, 31);
    await bounded(f.fetchStarted.promise);
    f.fetchFinished.resolve(new Response('PRIVATE_RESPONSE_BODY', { status: 503 }));
    const observed = await bounded(
      Promise.race([received, pending.then((response) => ({ response }))]),
    );
    if ('reply' in observed) finish(stream);
    const response = await pending;
    const body = await response.text();
    await server.close();
    const receipt = {
      request: { method: 'POST', url, body: request },
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body,
      upstream: decoded(stream),
      upstreamWireBase64: stream.writes.map((chunk) => chunk.toString('base64')),
      runCount: f.streams.length,
      cleanup: {
        listening: server.server.listening,
        openStreams: f.streams.filter((s) => !s.destroyed && !s.writableEnded).length,
        transportStopped: f.transportStopped(),
      },
    };
    if (process.env.NATIVE_CONTEXT_EVIDENCE === '1')
      process.stdout.write('READ_FAILURE_HTTP_RECEIPT ' + JSON.stringify(receipt) + '\n');
    expect(response.status, body).toBe(200);
    expect(object(JSON.parse(body)).choices).toMatchObject([
      { message: { content: 'CONTEXT_OK' }, finish_reason: 'stop' },
    ]);
    expect(object(object(object(reply(stream, 'readResult')?.message).value).result)).toMatchObject(
      { case: 'error', value: { path: pluginPath } },
    );
    expect(object(decoded(stream).at(-1)?.message)).toMatchObject({
      case: 'execClientControlMessage',
      value: { message: { case: 'streamClose', value: { id: 31 } } },
    });
    expect(receipt.runCount).toBe(1);
    expect(receipt.cleanup).toEqual({ listening: false, openStreams: 0, transportStopped: true });
  });

  it.each([
    '/etc/passwd',
    '/tmp/../etc/passwd',
    '/tmp/%2e%2e/secret',
    '/tmp/bad\u0000path',
    join(homedir(), '.cursor/skills-cursor/fixture-B/SKILL.md'),
  ])('never serves host or cross-account files for %s', async (path) => {
    const f = fixture();
    const pending = f.backend.complete(request);
    const stream = await bounded(f.opened);
    const received = onReply(stream, 'readResult');
    exec(stream, 'readArgs', { path });
    const result = await received;
    finish(stream);
    await bounded(pending);
    expect(object(object(object(result.message).value).result).case).toBe('rejected');
  });
});
