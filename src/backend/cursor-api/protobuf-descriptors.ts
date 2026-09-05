import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const mapSchema = z.discriminatedUnion('valueKind', [
  z.object({ keyScalar: z.number(), valueKind: z.literal('scalar'), valueScalar: z.number() }),
  z.object({
    keyScalar: z.number(),
    valueKind: z.literal('enum'),
    valueEnum: z.string().optional(),
  }),
  z.object({ keyScalar: z.number(), valueKind: z.literal('message'), valueMessage: z.string() }),
]);
const commonField = {
  no: z.number(),
  name: z.string(),
  localName: z.string(),
  repeated: z.boolean(),
  oneof: z.string().optional(),
  scalar: z.number().optional(),
  enum: z.string().optional(),
  message: z.string().optional(),
  map: mapSchema.optional(),
};
const fieldSchema = z.discriminatedUnion('kind', [
  z.object({ ...commonField, kind: z.literal('scalar'), scalar: z.number() }),
  z.object({ ...commonField, kind: z.literal('enum') }),
  z.object({ ...commonField, kind: z.literal('message'), message: z.string() }),
  z.object({ ...commonField, kind: z.literal('map'), map: mapSchema }),
]);
const descriptorSchema = z.object({
  format: z.literal(1),
  bundleVersion: z.string(),
  clientVersion: z.string(),
  roots: z.array(z.string()),
  services: z.array(
    z.object({
      service: z.string(),
      method: z.string(),
      input: z.string(),
      output: z.string(),
      kind: z.string(),
    }),
  ),
  messages: z.record(z.string(), z.object({ fields: z.array(fieldSchema) })),
});

export type ProtoFieldDescriptor = z.infer<typeof fieldSchema>;
// Programmatic descriptor sets retain their existing numeric format contract.
export interface ProtoDescriptorSet {
  readonly format: number;
  readonly bundleVersion: string;
  readonly clientVersion: string;
  readonly roots: string[];
  readonly services: Array<{
    service: string;
    method: string;
    input: string;
    output: string;
    kind: string;
  }>;
  readonly messages: Record<string, { fields: ProtoFieldDescriptor[] }>;
}
export type ProtoMapDescriptor = z.infer<typeof mapSchema>;
export type ProtoValueDescriptor =
  | { readonly kind: 'scalar'; readonly scalar: number }
  | { readonly kind: 'enum' }
  | { readonly kind: 'message'; readonly message: string };

export function unreachable(value: never): never {
  throw new TypeError(`Unexpected protobuf descriptor: ${String(value)}`);
}

export function mapValueDescriptor(map: ProtoMapDescriptor): ProtoValueDescriptor {
  switch (map.valueKind) {
    case 'scalar':
      return { kind: 'scalar', scalar: map.valueScalar };
    case 'enum':
      return { kind: 'enum' };
    case 'message':
      return { kind: 'message', message: map.valueMessage };
    default:
      return unreachable(map);
  }
}

const MISSING_DESCRIPTOR_MESSAGE =
  'Cursor API protobuf descriptors are missing. Run `npm run extract-protos` with cursor-agent installed, then rebuild — or set CURSOR_BRIDGE_CURSOR_API_DESCRIPTORS to an extracted proto-descriptors.json (for headless-only hosts without cursor-agent).';

export function loadProtoDescriptors(path?: string): ProtoDescriptorSet {
  const descriptorPath =
    path ?? fileURLToPath(new URL('./proto-descriptors.json', import.meta.url));
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(descriptorPath, 'utf8'));
  } catch (error) {
    const detail = error instanceof Error ? ` (${error.message})` : '';
    throw new Error(`${MISSING_DESCRIPTOR_MESSAGE}${detail}`, { cause: error });
  }
  const result = descriptorSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Cursor API protobuf descriptor file is invalid. Run \`npm run extract-protos\` again: ${descriptorPath}`,
      { cause: result.error },
    );
  }
  const descriptors = result.data;
  const interactionFields = new Set(
    descriptors.messages['agent.v1.InteractionUpdate']?.fields.map((field) => field.localName) ??
      [],
  );
  if (!interactionFields.has('partialToolCall') || !interactionFields.has('toolCallStarted')) {
    throw new Error(
      `Cursor API protobuf descriptor file is outdated. Run \`npm run extract-protos\` again: ${descriptorPath}`,
    );
  }
  return descriptors;
}
