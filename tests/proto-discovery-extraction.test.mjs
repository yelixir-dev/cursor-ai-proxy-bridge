import { expect, it } from 'vitest';
import { buildDescriptorOutput } from '../scripts/protos/descriptors.mjs';

function messageType(typeName, fields) {
  function Descriptor() {}
  Descriptor.typeName = typeName;
  Descriptor.fields = { list: () => fields };
  return Descriptor;
}

it('preserves native discovery when regenerating selected descriptors', () => {
  // Given: native field 44 and its argument schema, independent of the selector.
  const args = messageType('agent.v1.GetMcpToolsArgs', [
    { no: 1, name: 'server', localName: 'server', kind: 'scalar', T: 9 },
    {
      no: 2,
      name: 'tool_name',
      localName: 'toolName',
      kind: 'scalar',
      T: 9,
    },
    { no: 3, name: 'pattern', localName: 'pattern', kind: 'scalar', T: 9 },
    {
      no: 4,
      name: 'tool_call_id',
      localName: 'toolCallId',
      kind: 'scalar',
      T: 9,
    },
  ]);
  const discovery = messageType('agent.v1.GetMcpToolsToolCall', [
    { no: 1, name: 'args', localName: 'args', kind: 'message', T: args },
  ]);
  const call = messageType('agent.v1.ToolCall', [
    {
      no: 44,
      name: 'get_mcp_tools_tool_call',
      localName: 'getMcpToolsToolCall',
      kind: 'message',
      T: discovery,
      oneof: { localName: 'tool' },
    },
  ]);
  const types = new Map([args, discovery, call].map((type) => [type.typeName, type]));
  // When: the production selector runs on the native-shaped fixture.
  const output = buildDescriptorOutput({
    types,
    roots: ['agent.v1.ToolCall'],
    extraRoots: [],
    services: [],
    bundleVersion: 'fixture',
    extractedAt: '2026-10-01T00:00:00.000Z',
  });
  // Then: regeneration retains the discriminator and reachable argument values.
  expect(output.messages['agent.v1.ToolCall']?.fields).toEqual([
    {
      no: 44,
      name: 'get_mcp_tools_tool_call',
      localName: 'getMcpToolsToolCall',
      kind: 'message',
      repeated: false,
      oneof: 'tool',
      message: 'agent.v1.GetMcpToolsToolCall',
    },
  ]);
  expect(output.messages['agent.v1.GetMcpToolsToolCall']?.fields[0]?.message).toBe(
    'agent.v1.GetMcpToolsArgs',
  );
  expect(
    output.messages['agent.v1.GetMcpToolsArgs']?.fields.map((field) => [field.no, field.localName]),
  ).toEqual([
    [1, 'server'],
    [2, 'toolName'],
    [3, 'pattern'],
    [4, 'toolCallId'],
  ]);
});
