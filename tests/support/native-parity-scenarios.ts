import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { ChatCompletionRequest } from '../../src/backend/types.js';
import { protoValueToJson } from '../../src/backend/cursor-api/protobuf.js';
import { completion, initial, scenario, start, success } from './native-parity-http.js';
import type { EvidenceSink, HttpFixture } from './native-parity-http.js';
import { array, bounded, execReplies, object, oneof, runRequest } from './native-parity-wire.js';
import type { Dict, WireRun } from './native-parity-wire.js';

function run(f: HttpFixture, index = 0): WireRun {
  const value = f.transport.runs[index];
  assert.ok(value, 'Expected upstream Run ' + index);
  return value;
}
function resultCount(value: WireRun): number {
  return execReplies(value, 'mcpResult').length;
}
function context(value: WireRun): Dict {
  return object(
    oneof(object(execReplies(value, 'requestContextResult')[0]).result).value.requestContext,
  );
}
function parameter(value: WireRun, id: string): unknown {
  return array(object(runRequest(value).requestedModel).parameters ?? [])
    .map(object)
    .find((item) => item.id === id)?.value;
}
function model(value: WireRun): Dict {
  return object(runRequest(value).requestedModel);
}
function assertResult(value: WireRun): void {
  assert.equal(resultCount(value), 1);
  const result = oneof(object(execReplies(value, 'mcpResult')[0]).result);
  assert.equal(result.kind, 'success');
  assert.equal(
    oneof(object(array(result.value.content)[0]).content).value.text,
    'synthetic-result',
  );
}
function assertComplete(receipt: Parameters<typeof completion>[0]): void {
  const message = completion(receipt);
  assert.equal(message.content, 'synthetic-complete');
  assert.equal(message.tool_calls, undefined, 'Changed policy must not leak forbidden tool calls');
}
export async function unchanged(
  initialStream: boolean,
  resumedStream: boolean,
  sink?: EvidenceSink,
): Promise<void> {
  await scenario(
    'unchanged-' + Number(initialStream) + '-' + Number(resumedStream),
    async (f) => {
      const next = await start(f, initial(initialStream));
      // This listing selects B; continuation must still use the held A Run.
      success(await f.request('/v1/models'));
      assertComplete(await f.request('/v1/chat/completions', { ...next, stream: resumedStream }));
      assert.equal(f.transport.runs.length, 1);
      assert.equal(run(f).token, 'token-A');
      assertResult(run(f));
      assert.equal(f.backend.credentialStates().find((state) => state.id === 'A')?.routerPicks, 1);
    },
    sink,
  );
}
export const contractChanges = [
  'model',
  'reasoning',
  'tool-choice',
  'parallel-policy',
  'call-limit',
  'tool-schema',
  'tool-description',
  'history',
] as const;
export type ContractChange = (typeof contractChanges)[number];
function changed(request: ChatCompletionRequest, change: ContractChange): ChatCompletionRequest {
  const next = structuredClone(request);
  switch (change) {
    case 'model':
      next.model = 'sonnet-5';
      break;
    case 'reasoning':
      next.reasoning_effort = 'high';
      break;
    case 'tool-choice':
      next.tool_choice = 'none';
      break;
    case 'parallel-policy':
      next.parallel_tool_calls = false;
      break;
    case 'call-limit':
      next.max_tool_calls = 2;
      break;
    case 'history':
      next.messages[1] = { role: 'user', content: 'changed-fixture-question' };
      break;
    case 'tool-description': {
      const tool = next.tools?.[0];
      assert.ok(tool);
      tool.function.description = 'Changed fixture description';
      break;
    }
    case 'tool-schema': {
      const tool = next.tools?.[0];
      assert.ok(tool);
      tool.function.parameters = { type: 'object', properties: { value: { type: 'number' } } };
      break;
    }
  }
  return next;
}
export async function changedContract(
  change: ContractChange,
  stream: boolean,
  sink?: EvidenceSink,
): Promise<void> {
  await scenario(
    'changed-' + change + '-' + Number(stream),
    async (f) => {
      const first = initial(stream);
      if (change === 'reasoning') first.model = 'sonnet-5';
      const next = changed(await start(f, first), change);
      const original = run(f);
      f.transport.plans.push('text');
      assertComplete(await f.request('/v1/chat/completions', next));
      assert.equal(f.transport.runs.length, 2, 'Incompatible history/policy requires fresh Run');
      assert.equal(resultCount(original), 0, 'Never write results into incompatible old stream');
      assert.equal(original.stream.destroyed, true, 'Incompatible hold must be released');
      const fresh = run(f, 1);
      assert.equal(
        model(fresh).modelId,
        next.model === 'sonnet-5' ? 'claude-sonnet-5' : 'composer-2.5',
      );
      if (next.model === 'sonnet-5') {
        assert.equal(parameter(fresh, 'effort'), change === 'reasoning' ? 'high' : 'medium');
        assert.ok(['token-A', 'token-B'].includes(fresh.token));
        assert.equal(parameter(fresh, 'context'), fresh.token === 'token-A' ? '300k' : '500k');
      }
      const tools = array(context(fresh).tools ?? []);
      if (next.tool_choice === 'none') assert.deepEqual(tools, []);
      else {
        assert.equal(tools.length, 1);
        const definition = object(tools[0]);
        assert.equal(definition.description, next.tools?.[0]?.function.description);
        assert.deepEqual(
          protoValueToJson(object(definition.inputSchema)),
          next.tools?.[0]?.function.parameters,
        );
      }
      const user = fresh.roots.map(object).find((entry) => entry.role === 'user');
      assert.ok(user);
      assert.equal(object(array(user.content)[0]).text, next.messages[1]?.content);
      assert.ok(
        fresh.roots.map(object).some((entry) => entry.role === 'tool'),
        'Fresh Run replays tool result history',
      );
      assert.equal(oneof(object(runRequest(fresh).action).action).kind, 'resumeAction');
    },
    sink,
  );
}
export async function accountIsolation(sink?: EvidenceSink): Promise<void> {
  await scenario(
    'selected-account-not-last-listing',
    async (f) => {
      const listed = success(await f.request('/v1/models'));
      assert.equal(
        array(listed.data)
          .map(object)
          .find((item) => item.id === 'sonnet-5')?.context_window,
        300_000,
      );
      for (const [token, expected] of [
        ['token-B', '500k'],
        ['token-A', '300k'],
      ]) {
        f.transport.plans.push('text');
        assertComplete(
          await f.request('/v1/chat/completions', {
            model: 'sonnet-5',
            messages: [{ role: 'user', content: 'account-fixture' }],
          }),
        );
        const fresh = f.transport.runs.at(-1);
        assert.ok(fresh);
        assert.equal(fresh.token, token);
        assert.equal(fresh.endpoint, 'https://' + token + '.test');
        assert.equal(parameter(fresh, 'context'), expected);
        assert.equal(model(fresh).maxMode ?? false, false);
      }
      assert.equal(f.transport.runs.length, 2);
      assert.deepEqual(success(await f.request('/v1/models')), listed);
    },
    sink,
  );
}
export async function maxMode(sink?: EvidenceSink): Promise<void> {
  await scenario(
    'max-policy-context-and-run',
    async (f) => {
      const first = { ...initial(), model: 'sonnet-5' };
      const next = await start(f, first);
      assert.equal(parameter(run(f), 'context'), '300k');
      const patched = success(await f.request('/admin/config', { maxModeDefault: true }, 'PATCH'));
      const advertised = array(object(patched.state).models)
        .map(object)
        .find((item) => item.id === 'sonnet-5');
      assert.equal(advertised?.contextWindow, 1_000_000);
      assert.equal(advertised?.isMaxMode, true);
      f.transport.plans.push('text');
      assertComplete(await f.request('/v1/chat/completions', next));
      assert.equal(f.transport.runs.length, 2);
      assert.equal(resultCount(run(f)), 0);
      assert.equal(run(f).stream.destroyed, true);
      assert.equal(parameter(run(f, 1), 'context'), '1m');
      assert.equal(model(run(f, 1)).maxMode, true);
      success(await f.request('/admin/config', { maxModeDefault: false }, 'PATCH'));
      f.transport.plans.push('text');
      assertComplete(
        await f.request('/v1/chat/completions', {
          model: 'sonnet-5',
          messages: [{ role: 'user', content: 'standard-again' }],
        }),
      );
      assert.equal(parameter(run(f, 2), 'context'), '300k');
      assert.equal(model(run(f, 2)).maxMode ?? false, false);
    },
    sink,
    true,
  );
}
export const adminChanges = ['key', 'removal', 'disable', 'weight', 'label', 'noop'] as const;
export type AdminChange = (typeof adminChanges)[number];
function patch(change: AdminChange): Dict {
  switch (change) {
    case 'key':
      return { credentials: [{ id: 'A', apiKey: 'key-A2' }] };
    case 'removal':
      return { credentials: [{ id: 'A', _delete: true }] };
    case 'disable':
      return { credentials: [{ id: 'A', enabled: false }] };
    case 'weight':
      return { credentials: [{ id: 'A', weight: 7 }] };
    case 'label':
      return { credentials: [{ id: 'A', label: 'synthetic-renamed' }] };
    case 'noop':
      return { credentials: [{ id: 'A', apiKey: 'key-A', weight: 1, enabled: true }] };
  }
}
export async function adminHolds(change: AdminChange, sink?: EvidenceSink): Promise<void> {
  await scenario(
    'admin-holds-' + change,
    async (f) => {
      const a = await start(f);
      const b = await start(f);
      assert.deepEqual(
        f.transport.runs.map((value) => value.token),
        ['token-A', 'token-B'],
      );
      success(await f.request('/admin/config', patch(change), 'PATCH'));
      const invalidates = ['key', 'removal', 'disable'].includes(change);
      assert.equal(run(f).stream.destroyed, invalidates);
      assert.equal(run(f, 1).stream.destroyed, false, 'Unrelated B hold survives');
      assertComplete(await f.request('/v1/chat/completions', b));
      assertResult(run(f, 1));
      if (invalidates) {
        assert.equal(resultCount(run(f)), 0);
        f.transport.plans.push('text');
      }
      assertComplete(await f.request('/v1/chat/completions', a));
      assert.equal(f.transport.runs.length, invalidates ? 3 : 2);
      if (!invalidates) assertResult(run(f));
      else assert.notEqual(run(f, 2).token, 'token-A');
      if (change === 'key') {
        // Account A's replaced identity must receive fresh discovery, not old facts.
        for (let index = 0; index < 2; index += 1) {
          f.transport.plans.push('text');
          assertComplete(
            await f.request('/v1/chat/completions', {
              model: 'sonnet-5',
              messages: [{ role: 'user', content: 'replacement-fixture' }],
            }),
          );
        }
        const replacement = f.transport.runs.find(
          (value) => value.token === 'token-A2' && model(value).modelId === 'claude-sonnet-5',
        );
        assert.ok(replacement);
        assert.equal(parameter(replacement, 'context'), '700k');
        assert.equal(replacement.endpoint, 'https://token-A2.test');
      }
    },
    sink,
  );
}
export async function discoveryRace(sink?: EvidenceSink): Promise<void> {
  await scenario(
    'delayed-discovery-invalidation',
    async (f) => {
      const gate = f.transport.hold('token-A');
      const old = f.request('/v1/models');
      await bounded(gate.entered.promise);
      const updated = once(f.backend.changes, 'updated', { signal: AbortSignal.timeout(5_000) });
      const replacing = f.request('/admin/config', patch('key'), 'PATCH');
      try {
        await updated;
        // Mutation has completed; release the stale upstream response afterwards.
        gate.release.resolve();
        await bounded(gate.finished.promise);
        assert.notEqual(
          (await old).status,
          200,
          'Invalidated discovery waiter must not report stale success',
        );
        success(await replacing);
        const listed = success(await f.request('/v1/models'));
        assert.equal(
          array(listed.data)
            .map(object)
            .find((item) => item.id === 'sonnet-5')?.context_window,
          700_000,
        );
        f.transport.plans.push('text');
        assertComplete(
          await f.request('/v1/chat/completions', {
            model: 'sonnet-5',
            messages: [{ role: 'user', content: 'race-survivor' }],
          }),
        );
        assert.equal(parameter(run(f), 'context'), '700k');
        assert.equal(run(f).token, 'token-A2');
      } finally {
        gate.release.resolve();
        await Promise.all([old, replacing]);
      }
    },
    sink,
    true,
  );
}
export async function activeResumeInvalidation(sink?: EvidenceSink): Promise<void> {
  await scenario(
    'active-resume-retains-credential-cancellation',
    async (f) => {
      const next = await start(f);
      const original = run(f);
      const gate = f.transport.holdResult(original);
      const resumed = f.request('/v1/chat/completions', next);
      try {
        await bounded(gate.entered.promise);
        assertResult(original);
        success(await f.request('/admin/config', patch('key'), 'PATCH'));
        assert.ok(
          original.stream.destroyed || original.stream.writableEnded,
          'Active resumed Run lost credential generation cancellation when binding the new HTTP signal',
        );
        assert.notEqual((await resumed).status, 200);
        assert.equal(f.transport.runs.length, 1, 'Invalidation must not retry the old Run');
      } finally {
        gate.release.resolve();
        await resumed;
      }
    },
    sink,
    true,
  );
}
export async function runCase(name: string, sink?: EvidenceSink): Promise<void> {
  if (name === 'resume-contract') {
    for (const first of [false, true])
      for (const next of [false, true]) await unchanged(first, next, sink);
    for (const change of contractChanges)
      for (const stream of [false, true]) await changedContract(change, stream, sink);
  } else if (name === 'credential-isolation') {
    await accountIsolation(sink);
    await maxMode(sink);
    for (const change of adminChanges) await adminHolds(change, sink);
    await discoveryRace(sink);
    await activeResumeInvalidation(sink);
  } else throw new Error('Unknown QA case: ' + name);
}
