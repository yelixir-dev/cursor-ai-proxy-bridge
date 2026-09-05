const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const record = (value) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  !ArrayBuffer.isView(value);

function normalize(profile, freshRepositories) {
  const copy = globalThis.structuredClone(profile);
  const run = copy.run;
  const conversationId = run.conversationId;
  if (UUID.test(run.runId)) run.runId = '<run-id>';
  const message = run.action?.action?.value?.userMessage;
  if (record(message) && UUID.test(message.messageId)) message.messageId = '<message-id>';
  if (UUID.test(conversationId)) {
    run.conversationId = '<conversation-id>';
    if (run.conversationGroupId === conversationId) run.conversationGroupId = '<conversation-id>';
    const env = copy.context.env;
    const notes = env?.agentConversationNotesFolder;
    if (typeof notes === 'string' && notes.endsWith('/' + conversationId)) {
      env.agentConversationNotesFolder =
        notes.slice(0, -conversationId.length) + '<conversation-id>';
    }
  }
  if (freshRepositories) {
    for (const [index, repo] of (copy.context.repositoryInfo ?? []).entries()) {
      if (UUID.test(repo.repoName)) repo.repoName = '<fresh-repository:' + index + '>';
    }
  }
  return copy;
}

function differences(a, b, path, found) {
  if (Object.is(a, b)) return;
  if (ArrayBuffer.isView(a) && ArrayBuffer.isView(b)) {
    differences(
      [...new Uint8Array(a.buffer, a.byteOffset, a.byteLength)],
      [...new Uint8Array(b.buffer, b.byteOffset, b.byteLength)],
      path,
      found,
    );
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) found.push(path + '.length');
    for (let index = 0; index < Math.min(a.length, b.length); index++)
      differences(a[index], b[index], path + '[' + index + ']', found);
    return;
  }
  if (record(a) && record(b)) {
    for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      const child = path ? path + '.' + key : key;
      if (!Object.hasOwn(a, key) || !Object.hasOwn(b, key)) found.push(child);
      else differences(a[key], b[key], child, found);
    }
    return;
  }
  found.push(path);
}

// Account repository keys, caller payloads and all skill/plugin data remain significant.
export function compareClientProfiles(native, bridge, { freshRepositories = false } = {}) {
  const found = [];
  for (const [name, profile] of [
    ['native', native],
    ['bridge', bridge],
  ]) {
    if (!record(profile?.run)) found.push(name + '.run');
    if (!record(profile?.context)) found.push(name + '.context');
  }
  if (!found.length)
    differences(
      normalize(native, freshRepositories),
      normalize(bridge, freshRepositories),
      '',
      found,
    );
  return { ok: found.length === 0, differences: found };
}
