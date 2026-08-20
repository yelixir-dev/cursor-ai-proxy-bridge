import dotenv from 'dotenv';
import { BRIDGE_ENV_FILE } from '../config.js';

/**
 * Resolves the environment the locally started bridge effectively sees: the
 * caller's environment plus the bridge's own dotenv file semantics (same file,
 * no override). Used by the benchmark preflight so account comparability reads
 * the exact same configured credential the bridge would use without mutating
 * the parent process environment.
 */
export function bridgeEnvironment(
  environment: NodeJS.ProcessEnv,
  envFile: string = BRIDGE_ENV_FILE,
): NodeJS.ProcessEnv {
  const effective: NodeJS.ProcessEnv = { ...environment };
  dotenv.config({ path: envFile, processEnv: effective, quiet: true });
  return effective;
}
