export function canonicalToolExtension(): string {
  return `export default function (pi) {
  pi.registerTool({
    name: "echo_value",
    label: "Echo value",
    description: "Return the supplied benchmark value unchanged.",
    parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
    async execute(_id, params) {
      return { content: [{ type: "text", text: params.value }], details: {} };
    },
  });
  pi.registerTool({
    name: "lookup_code",
    label: "Lookup code",
    description: "Return the deterministic benchmark code for ALPHA or BETA.",
    parameters: { type: "object", properties: { key: { type: "string", enum: ["ALPHA", "BETA"] } }, required: ["key"], additionalProperties: false },
    async execute(_id, params) {
      const codes = { ALPHA: "A-17", BETA: "B-23" };
      return { content: [{ type: "text", text: codes[params.key] }], details: {} };
    },
  });
}\n`;
}
