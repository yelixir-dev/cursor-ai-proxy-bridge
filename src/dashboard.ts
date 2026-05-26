import type { BridgeConfig } from './config.js';
import type { BackendHealth, BridgeModel } from './backend/types.js';

export interface DashboardState {
  config: BridgeConfig;
  backendHealth: BackendHealth;
  models: BridgeModel[];
  uptimeSeconds: number;
  requestCount: number;
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function renderDashboard(state: DashboardState): string {
  const { config, backendHealth, models } = state;
  const authBadge = config.apiKey ? 'protected' : 'open';
  const workspaceBadge =
    config.workspaceMode === 'chat-only'
      ? 'chat-only temporary working directory; no real workspace is mounted by default'
      : `real workspace: ${config.realWorkspacePath ? 'configured' : 'missing path'}`;
  const modelRows = models
    .map(
      (model) =>
        `<li><code>${escapeHtml(model.id)}</code><span>${escapeHtml(model.owned_by)}</span></li>`,
    )
    .join('');
  const curlKey = config.apiKey ? 'Bearer $CURSOR_BRIDGE_API_KEY' : 'Bearer <not-configured>';

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Cursor AI Bridge Console</title>
<style>
:root{color-scheme:light;--paper:#eee5d2;--panel:#f8f2e5;--ink:#2f2b25;--muted:#706858;--line:#b9aa91;--accent:#8b6f42;--ok:#3d7653;--warn:#a25f2a;}
*{box-sizing:border-box}body{margin:0;background:linear-gradient(90deg,rgba(95,82,62,.08) 1px,transparent 1px),linear-gradient(rgba(95,82,62,.08) 1px,transparent 1px),var(--paper);background-size:22px 22px;font:15px/1.5 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--ink)}
main{width:min(1100px,100%);margin:0 auto;padding:20px}header{border:1px solid var(--line);background:rgba(248,242,229,.96);padding:18px;border-radius:18px;box-shadow:0 8px 24px rgba(59,46,29,.08)}
h1{margin:0;font-size:clamp(24px,7vw,44px);letter-spacing:-.04em;white-space:nowrap}.sub{color:var(--muted);margin-top:4px}.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:14px;margin-top:14px}.card{grid-column:span 6;border:1px solid var(--line);background:var(--panel);border-radius:16px;padding:16px;min-height:140px}.wide{grid-column:span 12}h2{margin:0 0 10px;font-size:18px}.kv{display:grid;grid-template-columns:1fr auto;gap:8px;border-top:1px dashed var(--line);padding-top:10px}.badge{display:inline-flex;border:1px solid var(--line);border-radius:999px;padding:3px 9px;background:#fff8ea}.ok{color:var(--ok)}.warn{color:var(--warn)}ul{list-style:none;padding:0;margin:0;display:grid;gap:8px}li{display:flex;justify-content:space-between;gap:12px;border-top:1px dashed var(--line);padding-top:8px}pre{white-space:pre-wrap;overflow:auto;background:#26231e;color:#f4ead6;border-radius:12px;padding:12px;font-size:12px}code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}a{color:var(--accent)}
@media(max-width:760px){main{padding:12px}.card{grid-column:span 12}header,.card{border-radius:14px}h1{font-size:28px}.kv{grid-template-columns:1fr}.badge{width:max-content}}
</style>
</head>
<body>
<main>
<header>
  <a href="https://github.com/yelixir-dev" rel="noreferrer">Yorha Workspace</a>
  <h1>Cursor AI Bridge Console</h1>
  <div class="sub">read-only status dashboard · no key management UI · no secrets rendered</div>
</header>
<section class="grid">
  <article class="card">
    <h2>Bridge Health</h2>
    <div class="kv"><span>Status</span><b class="${backendHealth.ok ? 'ok' : 'warn'}">${backendHealth.ok ? 'online' : 'degraded'}</b></div>
    <div class="kv"><span>Version</span><b>${escapeHtml(config.version)}</b></div>
    <div class="kv"><span>Uptime</span><b>${Math.floor(state.uptimeSeconds)}s</b></div>
    <div class="kv"><span>Requests</span><b>${state.requestCount}</b></div>
  </article>
  <article class="card">
    <h2>Security Boundary</h2>
    <div class="kv"><span>/v1 client auth</span><b class="badge">${authBadge}</b></div>
    <div class="kv"><span>Dashboard</span><b>redacted read-only</b></div>
    <div class="kv"><span>Secrets</span><b>not exposed</b></div>
  </article>
  <article class="card">
    <h2>Cursor Backend</h2>
    <div class="kv"><span>Type</span><b>${escapeHtml(backendHealth.type)}</b></div>
    <div class="kv"><span>Auth configured</span><b>${backendHealth.authConfigured ? 'yes' : 'not detected'}</b></div>
    <div class="kv"><span>Default model</span><b>${escapeHtml(config.defaultModel)}</b></div>
  </article>
  <article class="card">
    <h2>Workspace Safety</h2>
    <div class="kv"><span>Mode</span><b class="badge">${escapeHtml(config.workspaceMode)}</b></div>
    <p>${escapeHtml(workspaceBadge)}</p>
  </article>
  <article class="card wide">
    <h2>Models</h2>
    <ul>${modelRows}</ul>
  </article>
  <article class="card wide">
    <h2>Quick Smoke</h2>
    <pre>curl -s http://${escapeHtml(config.host)}:${config.port}/v1/models \\
  -H 'Authorization: ${escapeHtml(curlKey)}'

curl -s http://${escapeHtml(config.host)}:${config.port}/v1/chat/completions \\
  -H 'Authorization: ${escapeHtml(curlKey)}' \\
  -H 'Content-Type: application/json' \\
  -d '{"model":"${escapeHtml(config.defaultModel)}","messages":[{"role":"user","content":"hello"}]}'</pre>
  </article>
</section>
</main>
</body>
</html>`;
}
