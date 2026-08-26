import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  readDashboardConfigFile,
  redactedCredentials,
  type DashboardConfig,
  writeDashboardConfigFile,
} from '../src/dashboard-config.js';

describe('dashboard config persistence', () => {
  it('round-trips validated config and forces mode 0600', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'cursor-dashboard-')), 'nested', 'dashboard.json');
    const config = {
      server: { host: '127.0.0.1', port: 9997 },
      credentials: [
        {
          id: 'team',
          label: 'Team',
          apiKey: 'test-dashboard-secret',
          weight: 2,
          enabled: true,
          plan: 'ultra',
          capabilities: { fable: true },
        },
      ],
      modelOverrides: { 'composer-latest': true },
      credentialPolicy: {
        routingPolicy: 'ultra_last',
        failoverOn: 'auth_or_quota_or_5xx',
      },
    } satisfies DashboardConfig;

    writeDashboardConfigFile(path, config);
    expect(readDashboardConfigFile(path)).toEqual(config);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('tolerates invalid files with a warning', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'cursor-dashboard-invalid-')), 'dashboard.json');
    writeFileSync(path, '{invalid json');
    const warn = vi.fn();

    expect(readDashboardConfigFile(path, warn)).toEqual({});
    expect(warn).toHaveBeenCalledOnce();
  });

  it('redacts credentials without leaking complete keys', () => {
    const fullKey = 'test-full-api-key-value';
    const redacted = redactedCredentials([
      {
        id: 'one',
        label: 'One',
        apiKey: fullKey,
        weight: 3,
        enabled: false,
        plan: 'ultra',
        capabilities: { fable: true },
      },
    ]);
    const serialized = JSON.stringify(redacted);

    expect(redacted).toEqual([
      {
        id: 'one',
        label: 'One',
        apiKeyPreview: 'test…',
        weight: 3,
        enabled: false,
        plan: 'ultra',
        capabilities: { fable: true },
      },
    ]);
    expect(serialized).not.toContain(fullKey);
    expect(JSON.stringify(redactedCredentials([{ id: 'short', apiKey: 'tiny' }]))).not.toContain(
      'tiny',
    );
  });
});
