# Cursor AI Bridge

OpenAI-compatible HTTP bridge for Cursor AI with a safe, read-only operations dashboard.

This project is intentionally **not** a fork of `cursor-api-proxy`. It reuses the core idea of driving Cursor through the Cursor CLI/agent backend, while using a CommandCode-Bridge-style Fastify server boundary: Helmet/CSP, rate limiting, body limits, client API-key auth, and a redacted dashboard.

## Features

- `GET /health` redacted bridge/backend/workspace status
- `GET /dashboard` mobile-friendly read-only status page
- `GET /v1/models` OpenAI-compatible model list
- `POST /v1/chat/completions` non-streaming OpenAI-compatible chat completions
- `/v1/*` fail-closed client API-key auth via `Authorization: Bearer ...` or `x-api-key`
- Default `chat-only` mode uses a temporary working directory and does not mount a real workspace
- Explicit opt-in `real-workspace` mode with path validation
- No key-management UI, no token display, no `reset-hwid`

## Quick start

```bash
npm install
cp .env.example .env
# edit CURSOR_BRIDGE_API_KEY before exposing /v1 endpoints
npm run build
npm start
```

Open:

```text
http://127.0.0.1:9994/dashboard
```

Smoke:

```bash
curl -s http://127.0.0.1:9994/v1/models \
  -H "Authorization: Bearer $CURSOR_BRIDGE_API_KEY"

curl -s http://127.0.0.1:9994/v1/chat/completions \
  -H "Authorization: Bearer $CURSOR_BRIDGE_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"cursor-fast","messages":[{"role":"user","content":"hello"}]}'
```

## Configuration

| Variable                          | Default       | Notes                                                    |
| --------------------------------- | ------------- | -------------------------------------------------------- |
| `CURSOR_BRIDGE_HOST`              | `127.0.0.1`   | Bind address                                             |
| `CURSOR_BRIDGE_PORT`              | `9994`        | HTTP port                                                |
| `CURSOR_BRIDGE_API_KEY`           | unset         | Required for `/v1/*`; routes return 503 until configured |
| `CURSOR_BRIDGE_BACKEND`           | `mock`        | Use `cursor-cli` for real Cursor backend                 |
| `CURSOR_BRIDGE_DEFAULT_MODEL`     | `cursor-fast` | Dashboard/default hint                                   |
| `CURSOR_BRIDGE_WORKSPACE_MODE`    | `chat-only`   | `chat-only` or `real-workspace`                          |
| `CURSOR_BRIDGE_REAL_WORKSPACE`    | unset         | Required only for `real-workspace`                       |
| `CURSOR_BRIDGE_CURSOR_BIN`        | `cursor`      | Cursor CLI executable                                    |
| `CURSOR_BRIDGE_CURSOR_TIMEOUT_MS` | `120000`      | Clamped to 1s–10m                                        |

## Development

```bash
npm run verify
```

The current quality gate runs TypeScript typecheck, ESLint, Prettier check, Vitest, and build.
