#!/usr/bin/env node
/* global console, process */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeLoader } from './webpack-shim.mjs';

const ROOT_TYPES = [
  'aiserver.v1.GetMeRequest',
  'aiserver.v1.GetMeResponse',
  'aiserver.v1.GetServerConfigRequest',
  'aiserver.v1.GetServerConfigResponse',
  'aiserver.v1.AvailableModelsRequest',
  'aiserver.v1.AvailableModelsResponse',
  'agent.v1.GetUsableModelsRequest',
  'agent.v1.GetUsableModelsResponse',
  'agent.v1.GetDefaultModelForCliRequest',
  'agent.v1.GetDefaultModelForCliResponse',
  'agent.v1.AgentClientMessage',
  'agent.v1.AgentServerMessage',
];
const SERVICES = [
  {
    service: 'aiserver.v1.ServerConfigService',
    method: 'GetServerConfig',
    input: ROOT_TYPES[2],
    output: ROOT_TYPES[3],
    kind: 'unary',
  },
  {
    service: 'aiserver.v1.AiService',
    method: 'GetUsableModels',
    input: ROOT_TYPES[6],
    output: ROOT_TYPES[7],
    kind: 'unary',
  },
  {
    service: 'aiserver.v1.AiService',
    method: 'GetDefaultModelForCli',
    input: ROOT_TYPES[8],
    output: ROOT_TYPES[9],
    kind: 'unary',
  },
  {
    service: 'agent.v1.AgentService',
    method: 'Run',
    input: ROOT_TYPES[10],
    output: ROOT_TYPES[11],
    kind: 'bidi_streaming',
  },
];

function executablePath(raw) {
  if (!raw) return undefined;
  const candidate = raw.includes(path.sep)
    ? path.resolve(raw)
    : execFileSync('/usr/bin/which', [raw], { encoding: 'utf8' }).trim();
  return fs.realpathSync(candidate);
}

function resolveBundleDir() {
  const explicit = process.argv[2];
  if (explicit) return path.resolve(explicit);
  const configured = process.env.CURSOR_BRIDGE_CURSOR_BIN;
  if (configured) {
    try {
      const executable = executablePath(configured);
      if (executable && fs.existsSync(path.join(path.dirname(executable), 'index.js'))) {
        return path.dirname(executable);
      }
    } catch (error) {
      throw new Error(
        `Could not resolve CURSOR_BRIDGE_CURSOR_BIN=${JSON.stringify(configured)}: ${error.message}`,
        { cause: error },
      );
    }
  }
  const versions = path.join(os.homedir(), '.local', 'share', 'cursor-agent', 'versions');
  const candidates = fs.existsSync(versions)
    ? fs
        .readdirSync(versions)
        .filter((name) => fs.existsSync(path.join(versions, name, 'index.js')))
        .sort()
    : [];
  if (!candidates.length) {
    throw new Error(
      'No cursor-agent bundle found. Set CURSOR_BRIDGE_CURSOR_BIN to the installed cursor-agent executable.',
    );
  }
  return path.join(versions, candidates.at(-1));
}

const bundleDir = resolveBundleDir();
const loader = makeLoader(bundleDir);
const types = new Map();
function indexType(type) {
  if (typeof type !== 'function' || !type.typeName || !type.fields || types.has(type.typeName))
    return;
  types.set(type.typeName, type);
  for (const field of type.fields.list()) {
    if (field.kind === 'message' && typeof field.T === 'function') indexType(field.T);
    if (field.kind === 'map' && field.V?.kind === 'message' && typeof field.V.T === 'function')
      indexType(field.V.T);
  }
}
for (const key of loader.keys().filter((key) => key.includes('proto/dist/generated/'))) {
  try {
    for (const value of Object.values(loader.load(key))) indexType(value);
  } catch {
    // Some unrelated generated modules require lazy chunks. Root reachability below is authoritative.
  }
}
for (const root of ROOT_TYPES) {
  if (!types.has(root))
    throw new Error(`Required protobuf type not found in installed bundle: ${root}`);
  indexType(types.get(root));
}

SERVICES.unshift(
  {
    service: 'aiserver.v1.DashboardService',
    method: 'GetMe',
    input: ROOT_TYPES[0],
    output: ROOT_TYPES[1],
    kind: 'unary',
  },
  {
    service: 'aiserver.v1.AiService',
    method: 'AvailableModels',
    input: ROOT_TYPES[4],
    output: ROOT_TYPES[5],
    kind: 'unary',
  },
);

const SELECTED_FIELDS = new Map(
  Object.entries({
    'aiserver.v1.GetMeRequest': '*',
    'aiserver.v1.GetMeResponse': '*',
    'aiserver.v1.GetServerConfigResponse': ['agentUrlConfig'],
    'aiserver.v1.AvailableModelsRequest': '*',
    'aiserver.v1.AvailableModelsResponse': '*',
    'aiserver.v1.AvailableModelsResponse.AvailableModel': ['name', 'serverModelName', 'variants'],
    'aiserver.v1.AvailableModelsResponse.ModelVariantConfig': [
      'parameterValues',
      'isMaxMode',
      'isDefaultMaxConfig',
      'isDefaultNonMaxConfig',
      'variantStringRepresentation',
      'legacySlug',
    ],
    'aiserver.v1.AgentUrlConfig': ['agentUrl', 'agentnUrl'],
    'agent.v1.GetUsableModelsResponse': ['models'],
    'agent.v1.GetDefaultModelForCliResponse': ['model'],
    'agent.v1.ModelDetails': ['modelId', 'displayModelId', 'displayName', 'aliases', 'maxMode'],
    'agent.v1.AgentClientMessage': [
      'runRequest',
      'execClientMessage',
      'kvClientMessage',
      'clientHeartbeat',
    ],
    'agent.v1.AgentRunRequest': [
      'conversationState',
      'action',
      'requestedModel',
      'conversationId',
      'conversationGroupId',
      'mcpTools',
      'excludeWorkspaceContext',
      'selectedSubagentModels',
      'runId',
    ],
    'agent.v1.ConversationAction': ['userMessageAction'],
    'agent.v1.UserMessageAction': ['userMessage'],
    'agent.v1.UserMessage': [
      'text',
      'messageId',
      'selectedContext',
      'mode',
      'conversationStateBlobId',
    ],
    'agent.v1.SelectedContext': '*',
    'agent.v1.McpTools': '*',
    'agent.v1.RequestedModel': [
      'modelId',
      'maxMode',
      'parameters',
      'builtInModel',
      'isVariantStringRepresentation',
    ],
    'agent.v1.RequestedModel.ModelParameterValue': ['id', 'value'],
    'agent.v1.ExecClientMessage': '*',
    'agent.v1.McpAllowlistPrecheckResult': ['allowlisted'],
    'agent.v1.McpStateExecResult': ['success'],
    'agent.v1.McpStateSuccess': ['servers'],
    'agent.v1.McpStateServer': ['serverName', 'serverIdentifier', 'tools', 'status'],
    'agent.v1.ListMcpResourcesExecResult': ['success'],
    'agent.v1.ListMcpResourcesSuccess': ['resources'],
    'agent.v1.RequestContextResult': ['success'],
    'agent.v1.RequestContextSuccess': ['requestContext'],
    'agent.v1.RequestContext': [
      'env',
      'tools',
      'webSearchEnabled',
      'webFetchEnabled',
      'supportsMcpAuth',
      'gitRepoInfoComplete',
      'mcpInfoComplete',
      'rulesInfoComplete',
      'envInfoComplete',
      'repositoryInfoComplete',
      'customSubagentsInfoComplete',
      'agentSkillsInfoComplete',
      'mcpFileSystemInfoComplete',
      'gitStatusInfoComplete',
      'searchConversationsEnabled',
      'sendMessageEnabled',
    ],
    'agent.v1.RequestContextEnv': '*',
    'agent.v1.McpToolDefinition': '*',
    'agent.v1.KvClientMessage': ['id', 'getBlobResult', 'setBlobResult'],
    'agent.v1.GetBlobResult': ['blobData'],
    'agent.v1.SetBlobResult': '*',
    'agent.v1.ClientHeartbeat': '*',
    'agent.v1.AgentServerMessage': ['interactionUpdate', 'execServerMessage', 'kvServerMessage'],
    'agent.v1.InteractionUpdate': ['textDelta', 'thinkingDelta', 'tokenDelta', 'turnEnded'],
    'agent.v1.TextDeltaUpdate': ['text'],
    'agent.v1.ThinkingDeltaUpdate': ['text'],
    'agent.v1.TokenDeltaUpdate': ['tokens'],
    'agent.v1.TurnEndedUpdate': '*',
    'agent.v1.ExecServerMessage': '*',
    'agent.v1.McpArgs': ['name', 'args', 'toolCallId', 'providerIdentifier', 'toolName'],
    'agent.v1.KvServerMessage': ['id', 'getBlobArgs', 'setBlobArgs'],
    'agent.v1.GetBlobArgs': ['blobId'],
    'agent.v1.SetBlobArgs': ['blobId', 'blobData'],
    'google.protobuf.Value': '*',
    'google.protobuf.Struct': '*',
    'google.protobuf.ListValue': '*',
  }),
);
const execClientType = types.get('agent.v1.ExecClientMessage');
for (const resultField of execClientType?.fields.list() ?? []) {
  if (resultField.kind !== 'message' || !resultField.oneof) continue;
  const resultType = resultField.T;
  const failureField = resultType.fields
    .list()
    .find((field) =>
      ['rejected', 'error', 'permissionDenied', 'failure'].includes(field.localName ?? field.name),
    );
  if (!failureField || failureField.kind !== 'message' || SELECTED_FIELDS.has(resultType.typeName))
    continue;
  SELECTED_FIELDS.set(resultType.typeName, [failureField.localName ?? failureField.name]);
  SELECTED_FIELDS.set(failureField.T.typeName, '*');
}
const ALWAYS_DEEP = new Set([...ROOT_TYPES, ...SELECTED_FIELDS.keys()]);
const reachable = new Map();
function selectedFields(typeName, type) {
  const selection = SELECTED_FIELDS.get(typeName);
  if (selection === '*') return type.fields.list();
  if (!selection) return [];
  const names = new Set(selection);
  return type.fields.list().filter((field) => names.has(field.localName ?? field.name));
}
function visit(typeName) {
  if (reachable.has(typeName)) return;
  const type = types.get(typeName);
  if (!type) throw new Error(`Referenced protobuf type was not indexed: ${typeName}`);
  reachable.set(typeName, type);
  for (const field of selectedFields(typeName, type)) {
    if (field.kind === 'message' && ALWAYS_DEEP.has(field.T.typeName)) visit(field.T.typeName);
    if (field.kind === 'map' && field.V?.kind === 'message' && ALWAYS_DEEP.has(field.V.T.typeName))
      visit(field.V.T.typeName);
  }
}
ROOT_TYPES.forEach(visit);
function typeName(value) {
  return typeof value === 'function' ? value.typeName : value?.typeName;
}
function fieldDescriptor(field) {
  const result = {
    no: field.no,
    name: field.name,
    localName: field.localName ?? field.name,
    kind: field.kind,
    repeated: Boolean(field.repeated),
    ...(field.oneof ? { oneof: field.oneof.localName ?? field.oneof.name } : {}),
  };
  if (field.kind === 'scalar') result.scalar = field.T;
  else if (field.kind === 'enum') result.enum = typeName(field.T);
  else if (field.kind === 'message') result.message = typeName(field.T);
  else if (field.kind === 'map') {
    result.map = {
      keyScalar: field.K,
      valueKind: field.V.kind,
      ...(field.V.kind === 'scalar' ? { valueScalar: field.V.T } : {}),
      ...(field.V.kind === 'enum' ? { valueEnum: typeName(field.V.T) } : {}),
      ...(field.V.kind === 'message' ? { valueMessage: typeName(field.V.T) } : {}),
    };
  }
  return result;
}

const versionName = path.basename(bundleDir);
const output = {
  format: 1,
  extractedAt: new Date().toISOString(),
  bundleVersion: versionName,
  clientVersion: `cli-${versionName}`,
  roots: ROOT_TYPES,
  services: SERVICES,
  messages: Object.fromEntries(
    [...reachable]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, type]) => [name, { fields: selectedFields(name, type).map(fieldDescriptor) }]),
  ),
};
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = path.join(repoRoot, 'src', 'backend', 'cursor-api', 'proto-descriptors.json');
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(
  `Extracted ${Object.keys(output.messages).length} reachable message descriptors from ${bundleDir}`,
);
console.log(`Wrote ${outputPath}`);
