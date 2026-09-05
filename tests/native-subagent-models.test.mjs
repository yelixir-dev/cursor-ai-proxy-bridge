import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { CursorAuthProvider } from '../src/backend/cursor-api/auth.js';
import { CursorApiDiscovery } from '../src/backend/cursor-api/discovery.js';
import { runRequestMessage } from '../src/backend/cursor-api/mapper.js';
import { loadProtoDescriptors, ProtoCodec } from '../src/backend/cursor-api/protobuf.js';
import { createCursorApiRuntime } from '../src/backend/cursor-api/runtime.js';
import { fixtureNativeContext } from './support/native-context-fixture.js';

// Offline projection of the 2026-09-04 native chat AvailableModels capture.
// H1#11 response metadata specifies content-encoding=gzip; decode before protobuf.
// Original compressed response SHA-256: b15df5df9bba305c6432e4c62c5822fb25e1432d15ee526750a7fc1698a1acc0.
// Installed CLI 2026.08.25-3e8eec8 generated types retain all 36 models and all
// variant parameter values/selection flags/aliases, excluding unrelated metadata.
const AVAILABLE_GZIP = readFileSync(
  new URL('./fixtures/wire/native-cli-20260825-models.gzip.b64', import.meta.url),
  'utf8',
).trim();
// Exact native AgentRunRequest field 14 bytes, extracted using installed types;
// no conversation IDs, user content, credentials, or private fixture dependency.
const SELECTED_WIRE =
  'cgkKB2RlZmF1bHRyKAoIZ3Jvay00LjYaDgoGZWZmb3J0EgRoaWdoGgwKBGZhc3QSBHRydWVyHQoMY29tcG9zZXItMi41Gg0KBGZhc3QSBWZhbHNlclEKDWNsYXVkZS1vcHVzLTUaEAoIdGhpbmtpbmcSBHRydWUaDwoHY29udGV4dBIEMzAwaxoOCgZlZmZvcnQSBGhpZ2gaDQoEZmFzdBIFZmFsc2VyQgoLZ3B0LTUuNi1zb2waDwoHY29udGV4dBIEMjcyaxoTCglyZWFzb25pbmcSBm1lZGl1bRoNCgRmYXN0EgVmYWxzZXJFChBjbGF1ZGUtZmFibGUtNS0xGhAKCHRoaW5raW5nEgR0cnVlGg8KB2NvbnRleHQSBDMwMGsaDgoGZWZmb3J0EgRoaWdociwKEGdlbWluaS0zLjgtZmxhc2gaGAoQcmVhc29uaW5nX2VmZm9ydBIEaGlnaHJECg1ncHQtNS42LXRlcnJhGg8KB2NvbnRleHQSBDI3MmsaEwoJcmVhc29uaW5nEgZtZWRpdW0aDQoEZmFzdBIFZmFsc2VyRAoPY2xhdWRlLXNvbm5ldC01GhAKCHRoaW5raW5nEgR0cnVlGg8KB2NvbnRleHQSBDMwMGsaDgoGZWZmb3J0EgRoaWdo';
const codec = new ProtoCodec(loadProtoDescriptors());
const availableBytes = gunzipSync(Buffer.from(AVAILABLE_GZIP, 'base64'));
const nativeBytes = Buffer.from(SELECTED_WIRE, 'base64');
const nativeModels = codec.decode('agent.v1.AgentRunRequest', nativeBytes).selectedSubagentModels;
const parametersOnly = (models) =>
  models.map(({ modelId, parameters = [] }) => ({ modelId, parameters }));
const nativeDefaults = parametersOnly(nativeModels).map((model) =>
  model.modelId === 'composer-2.5'
    ? { ...model, parameters: [{ id: 'fast', value: 'true' }] }
    : model,
);
const request = { model: 'composer-2.5', messages: [{ role: 'user', content: 'fixture' }] };
const selectedParent = {
  modelId: 'composer-2.5',
  maxMode: false,
  parameters: [{ id: 'fast', value: 'false' }],
  builtInModel: false,
  isVariantStringRepresentation: false,
};

function mapped(models, parent = selectedParent) {
  return runRequestMessage(request, 'fixture-run', new Map(), undefined, parent, models).message
    .value.selectedSubagentModels;
}

function discoveryFixture(initial = availableBytes) {
  let bytes = initial;
  const credential = { id: 'fixture', apiKey: 'offline', enabled: true, weight: 1 };
  const runtime = createCursorApiRuntime(
    {
      host: '127.0.0.1',
      port: 0,
      backend: 'cursor-api',
      defaultModel: 'composer-2.5',
      workspaceMode: 'chat-only',
      version: 'test',
      cursorApiCredentials: [credential],
    },
    {
      environment: {},
      loadNativeContext: fixtureNativeContext,
      auth: new CursorAuthProvider({
        environment: {},
        fetch: async () =>
          new globalThis.Response(JSON.stringify({ accessToken: 'offline-token' })),
      }),
      transport: {
        async unary(path) {
          switch (path.split('/').at(-1)) {
            case 'GetServerConfig':
              return codec.encode('aiserver.v1.GetServerConfigResponse', {
                agentUrlConfig: { agentnUrl: 'https://offline.invalid' },
              });
            case 'AvailableModels':
              return bytes;
            case 'GetUsableModels':
              return codec.encode('agent.v1.GetUsableModelsResponse', {
                models: [{ modelId: 'composer-2.5', maxMode: false }],
              });
            case 'GetDefaultModelForCli':
              return codec.encode('agent.v1.GetDefaultModelForCliResponse', {
                model: { modelId: 'composer-2.5' },
              });
            default:
              throw new Error('Unexpected offline RPC: ' + path);
          }
        },
        async openRun() {
          throw new Error('Offline discovery must not open Run');
        },
      },
    },
  );
  const discovery = new CursorApiDiscovery(runtime);
  return {
    discovery,
    prepare: () => discovery.prepare(credential, 'offline-token'),
    replace(value) {
      bytes = codec.encode('aiserver.v1.AvailableModelsResponse', value);
      discovery.invalidateCredentials([credential.id]);
    },
  };
}

describe('native selectedSubagentModels', () => {
  it('preserves the actual native selected-only protobuf fixture', () => {
    expect(nativeModels).toHaveLength(9);
    expect(nativeModels.map((model) => model.modelId)).toContain('claude-fable-5-1');
    expect(nativeModels).toContainEqual({
      modelId: 'gemini-3.8-flash',
      parameters: [{ id: 'reasoning_effort', value: 'high' }],
    });
    expect(
      codec.encode('agent.v1.AgentRunRequest', { selectedSubagentModels: nativeModels }),
    ).toEqual(nativeBytes);
  });

  it('round-trips the captured exec stream close and its uint32 ID', () => {
    const captured = Buffer.from('KgIKAA==', 'base64');
    const message = {
      message: {
        case: 'execClientControlMessage',
        value: { message: { case: 'streamClose', value: {} } },
      },
    };
    expect(codec.decode('agent.v1.AgentClientMessage', captured)).toEqual(message);
    expect(codec.encode('agent.v1.AgentClientMessage', message)).toEqual(captured);
    message.message.value.message.value.id = 42;
    expect(codec.encode('agent.v1.AgentClientMessage', message)).toEqual(
      Buffer.from([0x2a, 4, 0x0a, 2, 0x08, 42]),
    );
  });

  it.each([false, true])(
    'normalizes main-model boolean defaults without mutating the catalogue: %s',
    (enabled) => {
      const parent = Object.freeze({
        ...selectedParent,
        maxMode: enabled,
        builtInModel: enabled,
        isVariantStringRepresentation: enabled,
      });
      const catalogue = new Map([[request.model, parent]]);
      const dto = runRequestMessage(request, 'fixture-run', catalogue).message.value.requestedModel;
      expect(dto).toEqual({
        modelId: parent.modelId,
        parameters: parent.parameters,
        ...(enabled
          ? { maxMode: true, builtInModel: true, isVariantStringRepresentation: true }
          : {}),
      });
      expect(catalogue.get(request.model)).toBe(parent);
      expect(parent.maxMode).toBe(enabled);
      expect(parent.builtInModel).toBe(enabled);
      expect(parent.isVariantStringRepresentation).toBe(enabled);
    },
  );

  it('retains native AvailableModel eligibility through the shipped descriptors', () => {
    const available = codec.decode('aiserver.v1.AvailableModelsResponse', availableBytes);
    expect(available.models).toHaveLength(36);
    expect(
      available.models
        .filter((model) => model.supportsAgent && model.defaultOn)
        .map((model) => model.name),
    ).toEqual(nativeModels.map((model) => model.modelId));
  });

  it('uses supplied catalogue defaults and only the selected parent parameters, exactly on wire', () => {
    expect(
      codec.encode('agent.v1.AgentRunRequest', {
        selectedSubagentModels: mapped(nativeDefaults),
      }),
    ).toEqual(nativeBytes);
  });

  it('inherits parent max mode for every subagent without leaking main-model flags', () => {
    const parent = {
      ...selectedParent,
      maxMode: true,
      builtInModel: true,
      isVariantStringRepresentation: true,
    };
    const expected = nativeModels.map((model) => ({ ...model, maxMode: true }));
    expect(
      codec.encode('agent.v1.AgentRunRequest', {
        selectedSubagentModels: mapped(nativeDefaults, parent),
      }),
    ).toEqual(codec.encode('agent.v1.AgentRunRequest', { selectedSubagentModels: expected }));
  });

  it('exposes immutable per-generation defaults while keeping Gemini outside public models', async () => {
    const fixture = discoveryFixture();
    const first = await fixture.prepare();
    expect(first.selectedSubagentModels).toEqual(nativeDefaults);
    expect(Object.isFrozen(first.selectedSubagentModels)).toBe(true);
    for (const model of first.selectedSubagentModels) {
      expect(Object.isFrozen(model)).toBe(true);
      expect(Object.isFrozen(model.parameters)).toBe(true);
      for (const parameter of model.parameters) expect(Object.isFrozen(parameter)).toBe(true);
    }
    expect(
      (await fixture.discovery.listModels()).some((model) => model.id.startsWith('gemini')),
    ).toBe(false);
    fixture.replace({
      models: [{ name: 'next-native-model', defaultOn: true, supportsAgent: true, variants: [] }],
    });
    const second = await fixture.prepare();
    expect(second.selectedSubagentModels).toEqual([
      { modelId: 'next-native-model', parameters: [] },
    ]);
    expect(first.selectedSubagentModels).toEqual(nativeDefaults);
    expect(
      codec.encode('agent.v1.AgentRunRequest', {
        selectedSubagentModels: mapped(first.selectedSubagentModels),
      }),
    ).toEqual(nativeBytes);
  });

  it('resolves defaults as non-max, max, first, or empty, and requires both eligibility flags', async () => {
    const variant = (value, flags = {}) => ({
      parameterValues: [{ id: 'effort', value }],
      ...flags,
    });
    const model = (name, variants, flags = {}) => ({
      name,
      defaultOn: true,
      supportsAgent: true,
      variants,
      ...flags,
    });
    const fixture = discoveryFixture();
    fixture.replace({
      models: [
        model('nonmax', [
          variant('first'),
          variant('max', { isDefaultMaxConfig: true }),
          variant('nonmax', { isDefaultNonMaxConfig: true }),
        ]),
        model('max', [variant('first'), variant('max', { isDefaultMaxConfig: true })]),
        model('first', [variant('first'), variant('second')]),
        model('empty', []),
        model('disabled', [], { defaultOn: false }),
        model('chat-only', [], { supportsAgent: false }),
        model('missing-support', [], { supportsAgent: undefined }),
        model('missing-default', [], { defaultOn: undefined }),
      ],
    });
    fixture.discovery.setMaxMode(true);
    const snapshot = await fixture.prepare();
    expect(snapshot.selectedSubagentModels).toEqual([
      { modelId: 'nonmax', parameters: [{ id: 'effort', value: 'nonmax' }] },
      { modelId: 'max', parameters: [{ id: 'effort', value: 'max' }] },
      { modelId: 'first', parameters: [{ id: 'effort', value: 'first' }] },
      { modelId: 'empty', parameters: [] },
    ]);
  });
});
