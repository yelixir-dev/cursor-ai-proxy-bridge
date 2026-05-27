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

Cursor AI Bridge is a trusted-environment HTTP bridge that exposes a small OpenAI-compatible API in front of Cursor's local CLI/agent backend. It keeps local automation behind a Fastify security boundary, client API-key auth, and a read-only operations dashboard.

> [!IMPORTANT]
> Cursor AI Bridge does **not** bundle Cursor credentials, tokens, or a hardware-ID reset feature. Use it only with your own Cursor CLI/account environment and expose it only on localhost or a trusted VPN/tailnet.

## At a glance

| Area            | Summary                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------- |
| API surface     | `/health`, `/dashboard`, `/v1/models`, `/v1/chat/completions`                                                             |
| Core value      | OpenAI-compatible clients can call a Cursor-backed local bridge instead of managing Cursor process invocation themselves. |
| Dashboard       | Mobile-friendly, read-only status page with backend, model, workspace, auth, and endpoint information.                    |
| Safety boundary | `/v1/*` fails closed without a configured client API key; real workspace access is explicit opt-in.                       |
| Current scope   | MVP: deterministic mock backend plus Cursor CLI backend adapter; non-streaming and SSE streaming chat completions.        |

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
- Normalizes OpenAI content-part arrays such as `[{"type":"text","text":"..."}]` into plain text before calling Cursor CLI.
- Avoids credential input forms, token display, credential persistence UI, and `reset-hwid` behavior.

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

For a real Cursor-backed run, switch the backend. Some Cursor installations expose the CLI binary as `cursor`; on the Oracle/systemd host it may be installed as `agent`, so point `CURSOR_BRIDGE_CURSOR_BIN` at the executable that works in that environment.

```env
CURSOR_BRIDGE_BACKEND=cursor-cli
CURSOR_BRIDGE_CURSOR_BIN=/home/ubuntu/.local/bin/agent
CURSOR_BRIDGE_DEFAULT_MODEL=composer-2.5
CURSOR_BRIDGE_CURSOR_TIMEOUT_MS=120000
```

The `cursor-cli` backend passes `--print --trust` for headless chat completions and deliberately omits `--mode`. With the regular `cursor` binary it runs `cursor agent --print ...`; with a standalone binary named `agent` it runs `agent --print ...` and omits the duplicate subcommand. `--trust` prevents headless workspace-trust prompts from blocking systemd runs, while omitting `--mode` keeps Cursor Agent in its writable default headless mode instead of the read-only `ask` or `plan` modes.

## First verification

Health check:

```bash
curl -fsS http://127.0.0.1:9994/health
```

Authenticated model list:

```bash
export CURSOR_BRIDGE_API_KEY="$YOUR_CURSOR_BRIDGE_API_KEY"

curl -fsS http://127.0.0.1:9994/v1/models \
  -H "Authorization: Bearer [BRIDGE_CLIENT_TOKEN]"
```

Non-streaming chat completion:

```bash
curl -sS http://127.0.0.1:9994/v1/chat/completions \
  -H "Authorization: Bearer [BRIDGE_CLIENT_TOKEN]" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "cursor-fast",
    "messages": [{"role": "user", "content": "Reply exactly: OK"}],
    "temperature": 0
  }'
```

SSE streaming chat completion:

```bash
curl -N -sS http://127.0.0.1:9994/v1/chat/completions \
  -H "Authorization: Bearer $CURSOR_BRIDGE_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "cursor-fast",
    "stream": true,
    "messages": [{"role": "user", "content": "Reply in chunks"}]
  }'
```

OpenAI content-part array requests are also accepted and normalized to plain text for the text-only Cursor CLI backend:

```bash
curl -sS http://127.0.0.1:9994/v1/chat/completions \
  -H "Authorization: Bearer $CURSOR_BRIDGE_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "composer-2.5",
    "messages": [
      {
        "role": "user",
        "content": [{"type": "text", "text": "Reply exactly: OK"}]
      }
    ]
  }'
```

Image blocks are represented as `[image omitted: cursor composer bridge is text-only]` because this bridge currently targets text chat completion semantics, not multimodal Cursor automation. Unsupported typed blocks are represented as `[unsupported content type omitted: <type>]`, and each message may include up to 1,000 content parts.

LiteLLM model entry example:

```yaml
model_name: composer-2.5
litellm_params:
  model: openai/composer-2.5
  api_base: http://127.0.0.1:9994/v1
  api_key: os.environ/CURSOR_BRIDGE_API_KEY
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

| Variable                          | Default       | Notes                                                                                                            |
| --------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------- |
| `CURSOR_BRIDGE_HOST`              | `127.0.0.1`   | HTTP bind address. Keep local-only unless behind trusted network controls.                                       |
| `CURSOR_BRIDGE_PORT`              | `9994`        | HTTP port.                                                                                                       |
| `CURSOR_BRIDGE_API_KEY`           | unset         | Required for `/v1/*`; missing key returns `503 configuration_error`.                                             |
| `CURSOR_BRIDGE_BACKEND`           | `mock`        | `mock` or `cursor-cli`.                                                                                          |
| `CURSOR_BRIDGE_DEFAULT_MODEL`     | `cursor-fast` | Default model and `/v1/models` discovery entry when custom (for example `composer-2.5`).                         |
| `CURSOR_BRIDGE_WORKSPACE_MODE`    | `chat-only`   | `chat-only` or `real-workspace`.                                                                                 |
| `CURSOR_BRIDGE_REAL_WORKSPACE`    | unset         | Required only for `real-workspace`; path must exist.                                                             |
| `CURSOR_BRIDGE_CURSOR_BIN`        | `cursor`      | Cursor CLI executable name/path; set to `/home/ubuntu/.local/bin/agent` when Cursor installs the CLI as `agent`. |
| `CURSOR_BRIDGE_CURSOR_TIMEOUT_MS` | `120000`      | Clamped to 1 second–10 minutes.                                                                                  |

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

## Security notes

- Treat this as a trusted-environment bridge, not a public internet service.
- Keep `CURSOR_BRIDGE_HOST=127.0.0.1` by default.
- If binding to `0.0.0.0`, place it behind a trusted VPN/tailnet/private proxy and keep a strong `CURSOR_BRIDGE_API_KEY`.
- Do not log or commit `.env`, Cursor auth files, tokens, or API keys.
- Keep real workspace mode off unless the caller is trusted.

## License

MIT. See `package.json` for the current package license declaration.
