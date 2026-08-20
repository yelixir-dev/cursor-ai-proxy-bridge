import { EXTRA_REACHABILITY_ROOTS, ROOT_TYPES, SERVICES } from './contracts.mjs';
import { SELECTED_FIELDS } from './selected-fields.mjs';

function withExecFailureSelections(types, baseSelections) {
  const selections = new Map(baseSelections);
  const execClientType = types.get('agent.v1.ExecClientMessage');
  for (const resultField of execClientType?.fields.list() ?? []) {
    if (resultField.kind !== 'message' || !resultField.oneof) continue;
    const resultType = resultField.T;
    const resultFields = resultType.fields.list();
    const failureField = resultFields.find((field) =>
      ['rejected', 'error', 'permissionDenied', 'failure'].includes(field.localName ?? field.name),
    );
    if (failureField?.kind !== 'message') continue;
    const failureName = failureField.localName ?? failureField.name;
    const existing = selections.get(resultType.typeName);
    if (existing !== undefined) {
      const keepsFailure = existing === '*' || existing.includes(failureName);
      if (keepsFailure && !selections.has(failureField.T.typeName)) {
        selections.set(failureField.T.typeName, '*');
      }
      continue;
    }
    const selectedNames = [failureName];
    const successField = resultFields.find(
      (field) => (field.localName ?? field.name) === 'success' && field.kind === 'message',
    );
    if (successField && selections.has(successField.T.typeName)) {
      selectedNames.unshift(successField.localName ?? successField.name);
    }
    selections.set(resultType.typeName, selectedNames);
    selections.set(failureField.T.typeName, '*');
  }
  return selections;
}

function selectedFields(typeName, type, selections) {
  const selection = selections.get(typeName);
  if (selection === '*') return type.fields.list();
  if (!selection) return [];
  const names = new Set(selection);
  return type.fields.list().filter((field) => names.has(field.localName ?? field.name));
}

function reachableTypes({ types, roots, extraRoots, selections }) {
  const alwaysDeep = new Set([...roots, ...selections.keys()]);
  const reachable = new Map();
  const visit = (typeName) => {
    if (reachable.has(typeName)) return;
    const type = types.get(typeName);
    if (!type) throw new Error(`Referenced protobuf type was not indexed: ${typeName}`);
    reachable.set(typeName, type);
    for (const field of selectedFields(typeName, type, selections)) {
      if (field.kind === 'message' && alwaysDeep.has(field.T.typeName)) visit(field.T.typeName);
      if (
        field.kind === 'map' &&
        field.V?.kind === 'message' &&
        alwaysDeep.has(field.V.T.typeName)
      ) {
        visit(field.V.T.typeName);
      }
    }
  };
  roots.forEach(visit);
  extraRoots.forEach(visit);
  return reachable;
}

function typeName(value) {
  return typeof value === 'function' ? value.typeName : value?.typeName;
}

export function fieldDescriptor(field) {
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

export function buildDescriptorOutput({
  types,
  bundleVersion,
  extractedAt,
  roots = ROOT_TYPES,
  services = SERVICES,
  selected = SELECTED_FIELDS,
  extraRoots = EXTRA_REACHABILITY_ROOTS,
}) {
  const selections = withExecFailureSelections(types, selected);
  const reachable = reachableTypes({ types, roots, extraRoots, selections });
  return {
    format: 1,
    extractedAt,
    bundleVersion,
    clientVersion: `cli-${bundleVersion}`,
    roots,
    services,
    messages: Object.fromEntries(
      [...reachable]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, type]) => [
          name,
          { fields: selectedFields(name, type, selections).map(fieldDescriptor) },
        ]),
    ),
  };
}

export function serializeDescriptorOutput(output) {
  return `${JSON.stringify(output, null, 2)}\n`;
}
