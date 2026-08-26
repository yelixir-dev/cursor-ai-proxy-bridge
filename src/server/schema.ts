import { z } from 'zod';
import {
  CURSOR_CREDENTIAL_FAILOVER_POLICIES,
  CURSOR_CREDENTIAL_ROUTING_POLICIES,
} from '../backend/cursor-api/credential-policy.js';
import { CURSOR_CREDENTIAL_PLANS } from '../backend/cursor-api/credential-plan.js';

const IMAGE_OMITTED_PLACEHOLDER = '[image omitted: cursor composer bridge is text-only]';
const MAX_CONTENT_PARTS = 1_000;
const HIDDEN_CHAIN_PART_TYPES = new Set(['thinking', 'redacted_thinking', 'reasoning']);
const TOOL_DESCRIPTION_MAX_INPUT_LENGTH = 200_000;
const TOOL_DESCRIPTION_BACKEND_LENGTH = 2_000;
const TOOL_DESCRIPTION_TRUNCATED_MARKER = '\n[description truncated by cursor composer bridge]';

function unsupportedContentPlaceholder(type: unknown): string {
  return typeof type === 'string' && type.length > 0
    ? `[unsupported content type omitted: ${type}]`
    : '[unsupported content block omitted]';
}

export function flattenMessageContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block);
      continue;
    }
    if (!block || typeof block !== 'object') continue;

    const type = Reflect.get(block, 'type');
    const text = Reflect.get(block, 'text');
    const nestedContent = Reflect.get(block, 'content');
    if (typeof type === 'string' && HIDDEN_CHAIN_PART_TYPES.has(type)) continue;
    if (typeof text === 'string') {
      parts.push(text);
      continue;
    }
    if (typeof nestedContent === 'string') {
      parts.push(nestedContent);
      continue;
    }
    if (type === 'image_url' || type === 'input_image') {
      parts.push(IMAGE_OMITTED_PLACEHOLDER);
      continue;
    }
    if (typeof type === 'string') parts.push(unsupportedContentPlaceholder(type));
  }
  return parts.join('\n');
}

const chatContentSchema = z
  .union([z.string(), z.null(), z.array(z.unknown()).max(MAX_CONTENT_PARTS)])
  .transform((content) => (content === null ? '' : flattenMessageContent(content)))
  .pipe(z.string().max(200_000));

const chatMessageSchema = z.object({
  role: z.enum(['system', 'developer', 'user', 'assistant', 'tool']),
  content: chatContentSchema,
  tool_calls: z
    .array(
      z.object({
        id: z.string().min(1).max(200),
        type: z.literal('function'),
        function: z.object({
          name: z.string().min(1).max(200),
          arguments: z.string().max(200_000),
        }),
      }),
    )
    .min(1)
    .max(100)
    .optional(),
  tool_call_id: z.string().min(1).max(200).optional(),
});

function normalizeToolDescription(description: string | undefined): string | undefined {
  if (description === undefined || description.length <= TOOL_DESCRIPTION_BACKEND_LENGTH) {
    return description;
  }
  return `${description.slice(
    0,
    TOOL_DESCRIPTION_BACKEND_LENGTH - TOOL_DESCRIPTION_TRUNCATED_MARKER.length,
  )}${TOOL_DESCRIPTION_TRUNCATED_MARKER}`;
}

const toolSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1).max(200),
    description: z
      .string()
      .max(TOOL_DESCRIPTION_MAX_INPUT_LENGTH)
      .optional()
      .transform(normalizeToolDescription),
    parameters: z.record(z.string(), z.unknown()).optional(),
  }),
});

const toolChoiceSchema = z.union([
  z.literal('none'),
  z.literal('auto'),
  z.literal('required'),
  z.object({
    type: z.literal('function'),
    function: z.object({ name: z.string().min(1).max(200) }),
  }),
]);

export const chatCompletionSchema = z.object({
  model: z.string().min(1).max(200).default('composer-2.5'),
  messages: z.array(chatMessageSchema).min(1).max(200),
  stream: z.boolean().optional().default(false),
  stream_options: z.object({ include_usage: z.boolean().optional().default(false) }).optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().max(200_000).optional(),
  tools: z.array(toolSchema).max(128).optional(),
  tool_choice: toolChoiceSchema.optional(),
  parallel_tool_calls: z.boolean().optional(),
  reasoning_effort: z.string().min(1).max(20).optional(),
});

export const adminConfigPatchSchema = z
  .object({
    credentials: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(100),
            label: z.string().trim().min(1).max(200).optional(),
            apiKey: z.string().trim().min(1).optional(),
            weight: z.number().positive().optional(),
            enabled: z.boolean().optional(),
            plan: z.enum(CURSOR_CREDENTIAL_PLANS).optional(),
            capabilities: z
              .object({
                fable: z.boolean().optional(),
              })
              .strict()
              .optional(),
            _delete: z.boolean().optional(),
          })
          .strict(),
      )
      .optional(),
    credentialPolicy: z
      .object({
        routingPolicy: z.enum(CURSOR_CREDENTIAL_ROUTING_POLICIES).optional(),
        failoverOn: z.enum(CURSOR_CREDENTIAL_FAILOVER_POLICIES).optional(),
      })
      .strict()
      .optional(),
    modelOverrides: z.record(z.string(), z.boolean().nullable()).optional(),
  })
  .strict();
