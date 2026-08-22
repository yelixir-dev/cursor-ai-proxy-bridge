import { z } from 'zod';
import type { CursorApiCredential } from '../backend/cursor-api/credentials.js';
import { cursorCredentialsFromConfig } from '../backend/cursor-api/credentials.js';
import { redactedConfig } from '../config.js';
import {
  dashboardConfigPath,
  redactedCredentials,
  writeDashboardConfigFile,
  type DashboardConfig,
  type DashboardCredential,
} from '../dashboard-config.js';
import { renderDashboard } from '../dashboard.js';
import { requireClientAuth } from './auth.js';
import { openAiError } from './responses.js';
import { adminConfigPatchSchema } from './schema.js';
import type { ServerContext } from './types.js';

/** Only the daily drivers are manageable from the dashboard. */
const DASHBOARD_VISIBLE_MODEL = /^composer-2\.5(-fast)?$/;

/** Dashboard configuration state: mutation is required for hot updates. */
type ManagementState = {
  dashboardConfig: DashboardConfig;
  effectiveCredentials: CursorApiCredential[];
};

export function registerManagementRoutes(context: ServerContext): void {
  const { app, config, backend, modelPolicy, health, startedAt } = context;
  const configPath = config.dashboardConfigPath ?? dashboardConfigPath(process.env);
  const state: ManagementState = {
    dashboardConfig: config.dashboardConfig ?? {},
    effectiveCredentials:
      config.cursorApiCredentials ??
      (backend.updateCredentials
        ? cursorCredentialsFromConfig({}, config.dashboardConfig?.credentials ?? [])
        : []),
  };

  const adminConfigResponse = async () => {
    const [backendHealth, models] = await Promise.all([backend.health(), backend.listModels()]);
    return {
      config: {
        server: { host: config.host, port: config.port },
        credentials: redactedCredentials(state.effectiveCredentials),
        modelOverrides: modelPolicy.snapshot(),
      },
      state: {
        activeBackend: backendHealth.activeBackend ?? backend.type,
        credentials: backend.credentialStates?.() ?? [],
        // The dashboard manages daily-driver models plus anything the user
        // explicitly toggled; everything else stays enabled by default
        // policy and is simply not rendered.
        models: models
          .filter(
            (model) =>
              DASHBOARD_VISIBLE_MODEL.test(model.id) || modelPolicy.source(model.id) === 'override',
          )
          .map((model) => ({
            id: model.id,
            enabled: modelPolicy.enabled(model.id),
            source: modelPolicy.source(model.id),
          })),
      },
    };
  };

  app.get('/health', async () => {
    const backendHealth = await health.get();
    return {
      status: backendHealth.ok ? 'ok' : 'degraded',
      bridge: redactedConfig(config),
      auth: {
        client_auth_enabled: config.clientAuth === 'on',
        client_api_key_configured: Boolean(config.apiKey),
      },
      backend: backendHealth,
      workspace: {
        mode: config.workspaceMode,
        real_workspace_configured: Boolean(config.realWorkspacePath),
      },
      uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
    };
  });

  app.get('/dashboard', async (_request, reply) => {
    reply.type('text/html; charset=utf-8');
    return renderDashboard(config.version);
  });

  app.get('/admin/config', async (request, reply) => {
    if (!(await requireClientAuth(request, reply, config))) return reply;
    return adminConfigResponse();
  });

  app.patch('/admin/config', async (request, reply) => {
    if (!(await requireClientAuth(request, reply, config))) return reply;
    const parsed = adminConfigPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(openAiError(z.prettifyError(parsed.error)));
    }

    const credentials = [...(state.dashboardConfig.credentials ?? [])];
    for (const update of parsed.data.credentials ?? []) {
      if (update.id === 'env') {
        if (update.apiKey !== undefined) {
          return reply
            .code(400)
            .send(openAiError("credential 'env' API key is controlled by CURSOR_API_KEY"));
        }
        return reply
          .code(400)
          .send(openAiError("credential 'env' cannot be changed through dashboard config"));
      }
      if (update.id === 'system') {
        return reply.code(400).send(openAiError("credential id 'system' is reserved"));
      }
      const index = credentials.findIndex((credential) => credential.id === update.id);
      if (update._delete) {
        if (index >= 0) credentials.splice(index, 1);
        continue;
      }
      const existing = index >= 0 ? credentials[index] : undefined;
      const apiKey = update.apiKey ?? existing?.apiKey;
      if (!apiKey) {
        return reply
          .code(400)
          .send(openAiError(`apiKey is required for new credential '${update.id}'`));
      }
      const next: DashboardCredential = {
        id: update.id,
        apiKey,
        weight: update.weight ?? existing?.weight ?? 1,
        enabled: update.enabled ?? existing?.enabled ?? true,
      };
      const label = update.label ?? existing?.label;
      if (label !== undefined) next.label = label;
      if (index >= 0) credentials[index] = next;
      else credentials.push(next);
    }

    const modelOverrides = { ...(state.dashboardConfig.modelOverrides ?? {}) };
    for (const [id, enabled] of Object.entries(parsed.data.modelOverrides ?? {})) {
      if (enabled === null) delete modelOverrides[id];
      else modelOverrides[id] = enabled;
    }
    const nextConfig: DashboardConfig = {
      ...state.dashboardConfig,
      credentials,
      modelOverrides,
    };
    writeDashboardConfigFile(configPath, nextConfig);
    state.dashboardConfig = nextConfig;
    const envCredential = state.effectiveCredentials.find((credential) => credential.id === 'env');
    state.effectiveCredentials = cursorCredentialsFromConfig(
      envCredential?.apiKey ? { CURSOR_API_KEY: envCredential.apiKey } : {},
      credentials,
    );
    backend.updateCredentials?.(state.effectiveCredentials);
    modelPolicy.replaceOverrides(modelOverrides);
    health.invalidate();
    return adminConfigResponse();
  });
}
