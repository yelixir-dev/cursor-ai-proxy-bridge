import { z } from 'zod';
import type { CursorCredentialPolicyConfig } from '../backend/cursor-api/credential-policy.js';
import {
  type CursorApiCredential,
  cursorCredentialsFromConfig,
} from '../backend/cursor-api/credentials.js';
import { redactedConfig } from '../config.js';
import { renderDashboard } from '../dashboard.js';
import {
  type DashboardConfig,
  type DashboardCredential,
  dashboardConfigPath,
  type EnvCredentialMetadata,
  redactedCredentials,
  writeDashboardConfigFile,
} from '../dashboard-config.js';
import { requireClientAuth } from './auth.js';
import { openAiError } from './responses.js';
import { adminConfigPatchSchema } from './schema.js';
import type { ServerContext } from './types.js';

/** Dashboard configuration state: mutation is required for hot updates. */
type ManagementState = {
  dashboardConfig: DashboardConfig;
  effectiveCredentials: CursorApiCredential[];
  credentialPolicy: CursorCredentialPolicyConfig;
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
    credentialPolicy: backend.credentialPolicy?.() ?? {
      routingPolicy:
        config.dashboardConfig?.credentialPolicy?.routingPolicy ?? 'weighted_round_robin',
      failoverOn: config.dashboardConfig?.credentialPolicy?.failoverOn ?? 'auth',
    },
  };

  const adminConfigResponse = async () => {
    const [backendHealth, models] = await Promise.all([backend.health(), backend.listModels()]);
    return {
      config: {
        server: { host: config.host, port: config.port },
        credentials: redactedCredentials(state.effectiveCredentials),
        credentialPolicy: state.credentialPolicy,
        modelOverrides: modelPolicy.snapshot(),
      },
      state: {
        activeBackend: backendHealth.activeBackend ?? backend.type,
        credentials: backend.credentialStates?.() ?? [],
        models: models
          .filter(
            (model) => modelPolicy.enabled(model.id) || modelPolicy.source(model.id) === 'override',
          )
          .map((model) => ({
            id: model.id,
            enabled: modelPolicy.enabled(model.id),
            source: modelPolicy.source(model.id),
            ...(model.credential_requirement === undefined
              ? {}
              : { credentialRequirement: model.credential_requirement }),
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

  app.get('/admin/credentials/usage', async (request, reply) => {
    if (!(await requireClientAuth(request, reply, config))) return reply;
    return {
      credentials: (await backend.credentialUsage?.({ force: false })) ?? [],
    };
  });

  app.post('/admin/credentials/usage/refresh', async (request, reply) => {
    if (!(await requireClientAuth(request, reply, config))) return reply;
    return {
      credentials: (await backend.credentialUsage?.({ force: true })) ?? [],
    };
  });

  app.patch('/admin/config', async (request, reply) => {
    if (!(await requireClientAuth(request, reply, config))) return reply;
    const parsed = adminConfigPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(openAiError(z.prettifyError(parsed.error)));
    }

    const credentials = [...(state.dashboardConfig.credentials ?? [])];
    let envCredentialMetadata = state.dashboardConfig.envCredentialMetadata;
    for (const update of parsed.data.credentials ?? []) {
      if (update.id === 'env') {
        if (update.apiKey !== undefined) {
          return reply
            .code(400)
            .send(openAiError("credential 'env' API key is controlled by CURSOR_API_KEY"));
        }
        if (
          update.label !== undefined ||
          update.weight !== undefined ||
          update.enabled !== undefined ||
          update._delete !== undefined
        ) {
          return reply
            .code(400)
            .send(openAiError("credential 'env' allows only plan and capabilities metadata"));
        }
        const nextMetadata: EnvCredentialMetadata = {
          ...envCredentialMetadata,
          ...(update.plan === undefined ? {} : { plan: update.plan }),
          ...(update.capabilities === undefined ? {} : { capabilities: update.capabilities }),
        };
        envCredentialMetadata = nextMetadata;
        continue;
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
      const plan = update.plan ?? existing?.plan;
      if (plan !== undefined) next.plan = plan;
      const capabilities = update.capabilities ?? existing?.capabilities;
      if (capabilities !== undefined) next.capabilities = capabilities;
      if (index >= 0) credentials[index] = next;
      else credentials.push(next);
    }

    const modelOverrides = { ...(state.dashboardConfig.modelOverrides ?? {}) };
    for (const [id, enabled] of Object.entries(parsed.data.modelOverrides ?? {})) {
      if (enabled === null) delete modelOverrides[id];
      else modelOverrides[id] = enabled;
    }
    const credentialPolicy = {
      ...state.credentialPolicy,
      ...parsed.data.credentialPolicy,
    };
    const credentialPolicyOverrides =
      parsed.data.credentialPolicy === undefined
        ? state.dashboardConfig.credentialPolicy
        : {
            ...state.dashboardConfig.credentialPolicy,
            ...parsed.data.credentialPolicy,
          };
    const nextConfig: DashboardConfig = {
      ...state.dashboardConfig,
      credentials,
      ...(envCredentialMetadata === undefined ? {} : { envCredentialMetadata }),
      ...(credentialPolicyOverrides === undefined
        ? {}
        : { credentialPolicy: credentialPolicyOverrides }),
      modelOverrides,
    };
    writeDashboardConfigFile(configPath, nextConfig);
    state.dashboardConfig = nextConfig;
    const envCredential = state.effectiveCredentials.find((credential) => credential.id === 'env');
    state.effectiveCredentials = cursorCredentialsFromConfig(
      envCredential?.apiKey ? { CURSOR_API_KEY: envCredential.apiKey } : {},
      credentials,
      envCredentialMetadata,
    );
    backend.updateCredentials?.(state.effectiveCredentials);
    state.credentialPolicy = credentialPolicy;
    backend.updateCredentialPolicy?.(credentialPolicy);
    modelPolicy.replaceOverrides(modelOverrides);
    health.invalidate();
    return adminConfigResponse();
  });
}
