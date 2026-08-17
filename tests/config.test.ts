import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';

function isolateClientAuthEnv(): void {
  vi.stubEnv('CURSOR_BRIDGE_API_KEY', undefined);
  vi.stubEnv('CURSOR_BRIDGE_AUTH', undefined);
  vi.stubEnv('CURSOR_BRIDGE_DASHBOARD_CONFIG', join(tmpdir(), 'missing-cursor-dashboard.json'));
}

afterEach(() => vi.unstubAllEnvs());

describe('bridge client auth config', () => {
  it('defaults to off without a client API key and on with one', () => {
    isolateClientAuthEnv();
    expect(loadConfig(join(tmpdir(), 'missing-cursor-env')).clientAuth).toBe('off');

    vi.stubEnv('CURSOR_BRIDGE_API_KEY', 'configured-key');
    expect(loadConfig(join(tmpdir(), 'missing-cursor-env')).clientAuth).toBe('on');
  });

  it('accepts explicit off and rejects invalid or incomplete auth settings', () => {
    isolateClientAuthEnv();
    vi.stubEnv('CURSOR_BRIDGE_AUTH', 'off');
    expect(loadConfig(join(tmpdir(), 'missing-cursor-env')).clientAuth).toBe('off');

    vi.stubEnv('CURSOR_BRIDGE_AUTH', 'on');
    expect(() => loadConfig(join(tmpdir(), 'missing-cursor-env'))).toThrow(
      'CURSOR_BRIDGE_AUTH=on requires CURSOR_BRIDGE_API_KEY',
    );

    vi.stubEnv('CURSOR_BRIDGE_AUTH', 'invalid');
    expect(() => loadConfig(join(tmpdir(), 'missing-cursor-env'))).toThrow(
      'CURSOR_BRIDGE_AUTH must be either on or off',
    );
  });
});
