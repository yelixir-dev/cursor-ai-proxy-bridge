import { z } from 'zod';
import type { ProtoCodec } from './protobuf.js';

const serverConfigSchema = z.object({
  indexingConfig: z.object({
    defaultUserPathEncryptionKey: z.string().optional(),
    defaultTeamPathEncryptionKey: z.string().optional(),
  }),
});
const repositoryStateSchema = z.object({ id: z.uuid() });

/** Read-only snapshot of the native <projectFolder>/repo.json. Caller owns persistence. */
export interface NativeRepositoryState {
  readonly id: string;
}

export function assertNativeRepositoryDescriptors(codec: ProtoCodec): void {
  for (const [type, number, name] of [
    ['aiserver.v1.GetServerConfigResponse', 3, 'indexingConfig'],
    ['aiserver.v1.IndexingConfig', 9, 'defaultUserPathEncryptionKey'],
    ['aiserver.v1.IndexingConfig', 10, 'defaultTeamPathEncryptionKey'],
  ] as const) {
    if (
      !codec.descriptors.messages[type]?.fields.some(
        (field) => field.no === number && field.localName === name,
      )
    ) {
      throw new Error('Missing native repository protobuf descriptor field');
    }
  }
}

/**
 * CLI 2026.08.25 ./src/project/repository-state-provider.ts getEncryptionKey():
 * absent IDE workspace state -> indexingConfig.defaultTeamPathEncryptionKey ??
 * defaultUserPathEncryptionKey. ../indexing-client/dist/index.js exports the original
 * masterKeyRaw unchanged; it does not generate or normalize a key for each HOME/repo.
 * This provider intentionally covers the isolated profile, not IDE state.vscdb discovery.
 */
export function nativeRepositoryEncryptionKey(response: unknown): string {
  const config = serverConfigSchema.safeParse(response);
  if (!config.success) throw new Error('Missing native repository encryption key configuration');
  const { defaultTeamPathEncryptionKey, defaultUserPathEncryptionKey } = config.data.indexingConfig;
  const key = defaultTeamPathEncryptionKey ?? defaultUserPathEncryptionKey;
  // Validate at the RPC boundary, but return the server's exact string. A present-invalid
  // team key must not silently fall back to the user key or a locally generated key.
  if (
    typeof key !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(key) ||
    Buffer.from(key, 'base64url').toString('base64url') !== key
  ) {
    throw new Error('Invalid native repository encryption key');
  }
  return key;
}

export function nativeRepositoryStateId(state: NativeRepositoryState): string {
  const parsed = repositoryStateSchema.safeParse(state);
  if (!parsed.success) throw new Error('Invalid native repository identity');
  return parsed.data.id;
}
