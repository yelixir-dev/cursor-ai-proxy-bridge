<p align="right">
  🌐 English · <a href="README.ko.md">한국어</a>
</p>

# Cursor AI Bridge

<p align="center">
  <img src="docs/assets/readme/dashboard.png" alt="Cursor AI Bridge read-only dashboard" width="760">
</p>

<p align="center">
  <strong>OpenAI-compatible gateway for local Cursor AI automation, with a safe read-only operations dashboard.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Status-MVP-8b7355?style=flat-square" alt="MVP status">
  <img src="https://img.shields.io/badge/Node.js-20%2B-5fa04e?style=flat-square" alt="Node.js 20+">
  <img src="https://img.shields.io/badge/API-OpenAI--compatible-6b7280?style=flat-square" alt="OpenAI-compatible API">
  <img src="https://img.shields.io/badge/Dashboard-read--only-b08968?style=flat-square" alt="Read-only dashboard">
  <img src="https://img.shields.io/badge/License-MIT-2ea44f?style=flat-square" alt="MIT License">
</p>

Cursor AI Bridge is a trusted-environment HTTP bridge that exposes a small OpenAI-compatible API in front of Cursor's local CLI/agent backend. It is designed as a sibling to Yorha's CommandCode Bridge: same Fastify security boundary and operator dashboard philosophy, but without upstream key-management UI.

> [!IMPORTANT]
> Cursor AI Bridge does **not** bundle Cursor credentials, tokens, or a hardware-ID reset feature. Use it only with your own Cursor CLI/account environment and expose it only on localhost or a trusted VPN/tailnet.

> [!NOTE]
> This repository is a reconstruction, not a direct fork of `anyrobert/cursor-api-proxy`. The upstream project was read and used as a reference for Cursor CLI/agent invocation ideas; server auth, dashboard, workspace policy, and tests were rebuilt around the CommandCode Bridge safety model.

## At a glance

| Area            | Summary                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------- |
| API surface     | `/health`, `/dashboard`, `/v1/models`, `/v1/chat/completions`                                                             |
| Core value      | OpenAI-compatible clients can call a Cursor-backed local bridge instead of managing Cursor process invocation themselves. |
| Dashboard       | Mobile-friendly, read-only status page with backend, model, workspace, auth, and endpoint information.                    |
| Safety boundary | `/v1/*` fails closed without a configured client API key; real workspace access is explicit opt-in.                       |
| Current scope   | MVP: deterministic mock backend plus Cursor CLI backend adapter; non-streaming chat completions first.                    |

One-shot local preview:

```bash
npm install
CURSOR_BRIDGE_API_KEY=sk-curbr-local-dev \
CURSOR_BRIDGE_BACKEND=mock \
npm run build && npm start
```

Then open:

```text
http://127.0.0.1:9994/dashboard
```

A healthy preview shows a read-only dashboard and returns OpenAI-compatible model/chat responses from the mock backend.

## What this bridge does

- Provides OpenAI-compatible endpoints:
  - `GET /health`
  - `GET /dashboard`
  - `GET /v1/models`
  - `POST /v1/chat/completions`
- Requires client API-key auth for `/v1/*` through either:
  - `Authorization: Bearer <CURSOR_BRIDGE_API_KEY>`
  - `x-api-key: <CURSOR_BRIDGE_API_KEY>`
- Returns `503 configuration_error` on `/v1/*` when `CURSOR_BRIDGE_API_KEY` is not configured.
- Ships a deterministic `mock` backend for dashboard/API smoke tests without Cursor login state.
- Includes a `cursor-cli` backend adapter for local Cursor CLI/agent execution.
- Defaults to `chat-only` temporary workspace mode so real project files are not mounted by default.
- Supports explicit `real-workspace` mode only when a real workspace path is configured and valid.
- Uses Fastify with Helmet/CSP, body limits, rate limiting, and Zod request validation.
- Avoids key input forms, token display, upstream credential persistence UI, and `reset-hwid` behavior.

## Architecture

```text
OpenAI-compatible client
  -> Cursor AI Bridge :9994
  -> Cursor CLI / agent backend
  -> normalized OpenAI chat.completion response
```

```mermaid
flowchart LR
  C[OpenAI-compatible client] -->|Bearer / x-api-key| B[Cursor AI Bridge]
  D[Read-only dashboard] -->|status only| B
  B --> H[/health]
  B --> M[/v1/models]
  B --> X[/v1/chat/completions]
  X --> W{Workspace mode}
  W -->|default| T[Temporary chat-only directory]
  W -->|explicit opt-in| R[Real workspace path]
  X --> A[Cursor CLI backend]
```

The bridge keeps the HTTP/auth/dashboard boundary separate from Cursor upstream authentication. Cursor login/session material should remain owned by the local Cursor CLI environment, not by this dashboard.

## Requirements

- Node.js **20+**
- npm **10+**
- macOS, Linux, or WSL for source operation
- Cursor CLI/account environment for real `cursor-cli` backend use
- A configured client-facing `CURSOR_BRIDGE_API_KEY` for `/v1/*` traffic

For UI/API development and smoke testing, the `mock` backend does not require Cursor login.

## Installation

```bash
git clone <your-cursor-ai-bridge-repository-url> cursor-ai-bridge
cd cursor-ai-bridge
npm install
cp .env.example .env
```

Minimal local `.env`:

```env
CURSOR_BRIDGE_HOST=127.0.0.1
CURSOR_BRIDGE_PORT=9994
CURSOR_BRIDGE_API_KEY=replace-with-a-long-random-client-key
CURSOR_BRIDGE_BACKEND=mock
CURSOR_BRIDGE_WORKSPACE_MODE=chat-only
```

Build and run:

```bash
npm run build
npm start
```

For a real Cursor-backed run, switch the backend:

```env
CURSOR_BRIDGE_BACKEND=cursor-cli
CURSOR_BRIDGE_CURSOR_BIN=cursor
CURSOR_BRIDGE_CURSOR_TIMEOUT_MS=120000
```

## First verification

Health check:

```bash
curl -fsS http://127.0.0.1:9994/health
```

Authenticated model list:

```bash
export CURSOR_BRIDGE_API_KEY="$YOUR_CURSOR_BRIDGE_API_KEY"

curl -fsS http://127.0.0.1:9994/v1/models \
  -H "Authorization: Bearer $CURSOR_BRIDGE_API_KEY"
```

Non-streaming chat completion:

```bash
curl -sS http://127.0.0.1:9994/v1/chat/completions \
  -H "Authorization: Bearer $CURSOR_BRIDGE_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "cursor-fast",
    "messages": [{"role": "user", "content": "Reply exactly: OK"}],
    "temperature": 0
  }'
```

## Web dashboard

Open:

```text
http://127.0.0.1:9994/dashboard
```

The dashboard is intentionally read-only. It can show:

- bridge version, uptime, and request counters;
- backend mode and backend health;
- auth configured/not-configured state without printing the API key;
- workspace safety mode;
- available model IDs;
- curl examples with redacted key placeholders.

It does **not** include a key input/save UI. If admin writes are added later, they should use a separate admin policy and keep `/v1/*` client authentication fail-closed.

## Configuration

| Variable                          | Default       | Notes                                                                      |
| --------------------------------- | ------------- | -------------------------------------------------------------------------- |
| `CURSOR_BRIDGE_HOST`              | `127.0.0.1`   | HTTP bind address. Keep local-only unless behind trusted network controls. |
| `CURSOR_BRIDGE_PORT`              | `9994`        | HTTP port.                                                                 |
| `CURSOR_BRIDGE_API_KEY`           | unset         | Required for `/v1/*`; missing key returns `503 configuration_error`.       |
| `CURSOR_BRIDGE_BACKEND`           | `mock`        | `mock` or `cursor-cli`.                                                    |
| `CURSOR_BRIDGE_DEFAULT_MODEL`     | `cursor-fast` | Default dashboard/model hint.                                              |
| `CURSOR_BRIDGE_WORKSPACE_MODE`    | `chat-only`   | `chat-only` or `real-workspace`.                                           |
| `CURSOR_BRIDGE_REAL_WORKSPACE`    | unset         | Required only for `real-workspace`; path must exist.                       |
| `CURSOR_BRIDGE_CURSOR_BIN`        | `cursor`      | Cursor CLI executable name/path.                                           |
| `CURSOR_BRIDGE_CURSOR_TIMEOUT_MS` | `120000`      | Clamped to 1 second–10 minutes.                                            |

## Workspace safety

Default mode:

```env
CURSOR_BRIDGE_WORKSPACE_MODE=chat-only
```

In this mode, each request runs through a temporary chat-only directory. This is the safe default for bridge experiments because it avoids exposing a real project checkout to automated requests.

Real workspace mode must be explicit:

```env
CURSOR_BRIDGE_WORKSPACE_MODE=real-workspace
CURSOR_BRIDGE_REAL_WORKSPACE=/absolute/path/to/project
```

The configured path must exist. Do not bind a sensitive workspace unless the calling client and network boundary are trusted.

## Client authentication

`CURSOR_BRIDGE_API_KEY` is the client-facing bridge key, not a Cursor upstream credential.

```env
CURSOR_BRIDGE_API_KEY=replace-with-a-long-random-client-key
```

Supported request headers:

```http
Authorization: Bearer <key>
x-api-key: <key>
```

Security behavior:

- `/health` and `/dashboard` are unauthenticated read-only status endpoints.
- `/v1/models` and `/v1/chat/completions` require the client key.
- If the client key is unset, `/v1/*` returns `503` instead of opening the bridge.
- Raw keys and Cursor auth material are never printed by the dashboard.

## Development

```bash
npm run verify
```

The quality gate runs:

- TypeScript typecheck
- ESLint
- Prettier format check
- Vitest tests
- production build

Useful commands:

```bash
npm run dev
npm test
npm run typecheck
npm run lint
npm run build
npm audit --omit=dev
```

## Upstream reference and reconstruction notes

Reference project inspected:

```text
https://github.com/anyrobert/cursor-api-proxy
```

Reused as ideas:

- Cursor CLI/agent backend invocation shape;
- model mapping concepts;
- request-to-agent prompt flow.

Rebuilt for this project:

- Fastify server shell;
- `/v1/*` fail-closed client auth;
- read-only dashboard;
- Helmet/CSP policy for local HTTP;
- workspace safety model;
- tests, validation, and smoke verification.

Intentionally excluded:

- key-management dashboard UI;
- raw token/cache display;
- `reset-hwid` or device identity manipulation;
- broad admin control plane.

## Security notes

- Treat this as a trusted-environment bridge, not a public internet service.
- Keep `CURSOR_BRIDGE_HOST=127.0.0.1` by default.
- If binding to `0.0.0.0`, place it behind a trusted VPN/tailnet/private proxy and keep a strong `CURSOR_BRIDGE_API_KEY`.
- Do not log or commit `.env`, Cursor auth files, tokens, or API keys.
- Keep real workspace mode off unless the caller is trusted.

## Current limitations

- Streaming responses are not part of the MVP endpoint contract yet.
- The `cursor-cli` adapter is intentionally minimal and should be expanded with provider-specific integration tests before production use.
- No installer/service packaging is included yet.
- The dashboard is read-only; configuration changes are environment-driven.

## License

MIT. See `package.json` for the current package license declaration.
