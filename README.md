<p align="center">
  <img src="docs/assets/banner.svg" alt="Cursor AI Bridge, OpenAI-compatible Cursor proxy" width="880">
</p>

<p align="center">
  <strong>OpenAI-compatible Cursor access, with a headless path and a CLI fallback.</strong>
</p>

<p align="center">
  <img alt="Node.js 22+" src="https://img.shields.io/badge/Node.js-22%2B-b57920">
  <img alt="TypeScript 6.x" src="https://img.shields.io/badge/TypeScript-6.x-1f6f78">
  <img alt="OpenAI-compatible API" src="https://img.shields.io/badge/API-OpenAI--compatible-9f4d2e">
</p>

<!-- README-I18N:START -->

**English** | [한국어](./README.ko.md)

<!-- README-I18N:END -->

**[Cursor AI Bridge](https://github.com/yelixir-dev/cursor-ai-proxy-bridge)** is a local TypeScript proxy for Node.js 22+ that gives Cursor Agent an OpenAI-compatible surface at `/v1/chat/completions` and `/v1/models`. It routes between two backends, headless `cursor-api` and `cursor-cli`, with `auto` as the default.

[What it does](#what-it-does) · [Install](#install) · [Usage](#usage) · [How it works](#how-it-works) · [Repository layout](#repository-layout) · [Current limitations](#current-limitations) · [License](#license)

## What it does

- **OpenAI-compatible routes.** `GET /v1/models` exposes the curated model list, while `POST /v1/chat/completions` accepts normal and streaming requests.
- **Headless first, CLI ready.** The headless-direct `cursor-api` backend speaks an unofficial, reverse-engineered `agent.v1` Connect-RPC protocol with no CLI required at runtime, and `cursor-cli` remains the fallback; `auto` fails over and later probes for recovery.
- **SSE and real usage.** Chat completions stream as server-sent events, and responses expose `prompt_tokens`, `completion_tokens`, and `total_tokens`; `cursor-api` maps actual upstream turn usage while `cursor-cli` uses reported values or its documented estimate when Cursor omits them.
- **Tool calls with control.** Single, parallel, sequential, forced, required, auto, and none modes are supported, with tool history and JSON Schema argument validation at the bridge boundary.
- **Weighted credentials.** `CURSOR_API_KEY` and dashboard credentials are routed by weight; an authentication failure cools down only the failed credential, retries once with another available credential, and recovers lazily after cooldown.
- **Curated model families.** Composer 2.5, Cursor Grok 4.6, Claude 5 Opus, Sonnet, and Fable, GPT-5.6 Sol, Terra, and Luna, Kimi K3, GLM 5.2, `default`, and `auto` are enabled by policy, while dashboard overrides can expose or hide other discovered models.
- **A local management console.** `/dashboard` shows bridge and backend status, supports managed credential CRUD, and groups model family toggles with bulk enable and disable actions.

## Install

Node.js 22+ and npm are required. Install from the repository with the existing npm workflow:

```bash
git clone https://github.com/yelixir-dev/cursor-ai-proxy-bridge.git
cd cursor-ai-proxy-bridge
npm install
cp .env.example .env
npm run build
npm start
```

The default address is `http://127.0.0.1:9996`. Set `CURSOR_BRIDGE_API_KEY` before using `CURSOR_BRIDGE_AUTH=on`; when the client key is unset, auth defaults to `off` and startup logs a warning. `CURSOR_BRIDGE_BACKEND=auto` is the default. Set it to `cursor-api` or `cursor-cli` to force a backend.

### Descriptor snapshot for headless hosts

`cursor-api` connects directly to Cursor's service and needs a descriptor snapshot. On a machine with `cursor-agent` installed, extract the snapshot, build, and start the direct backend:

```bash
CURSOR_BRIDGE_CURSOR_BIN="$HOME/.local/bin/cursor-agent" npm run extract-protos
npm run build
CURSOR_BRIDGE_BACKEND=cursor-api npm start
```

The generated `src/backend/cursor-api/proto-descriptors.json` is gitignored and copied into `dist` by the build. For a host without the CLI, run `npm run extract-protos` on a machine that has `cursor-agent`, copy the generated `proto-descriptors.json`, and set `CURSOR_BRIDGE_CURSOR_API_DESCRIPTORS` to its path. Set `CURSOR_API_KEY` from Cursor Dashboard -> API Keys for headless authentication. `CURSOR_AUTH_TOKEN` is also accepted, and a system credential can use the macOS Keychain when no env or dashboard credential is present.

### npm scripts

| Command                  | Purpose                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------- |
| `npm run dev`            | Watch `src/index.ts` with `tsx`.                                                    |
| `npm run build`          | Compile TypeScript and copy the descriptor snapshot when present.                   |
| `npm start`              | Start `dist/index.js`.                                                              |
| `npm run clean`          | Remove `dist`.                                                                      |
| `npm run extract-protos` | Extract the reachable protocol descriptors from an installed `cursor-agent` bundle. |
| `npm run typecheck`      | Run TypeScript without emitting files.                                              |
| `npm run lint`           | Run ESLint.                                                                         |
| `npm run format`         | Format the repository with Prettier.                                                |
| `npm run format:check`   | Check repository formatting with Prettier.                                          |
| `npm run test`           | Run the Vitest suite with one worker.                                               |
| `npm run test:e2e`       | Build and run the Node smoke test against a real backend.                           |
| `npm run verify`         | Run typecheck, lint, format check, tests, and build.                                |

### End to end smoke test

Run `npm run test:e2e` with a usable Cursor backend. It consumes real Cursor quota and checks authentication, chat, tools, SSE, malformed requests, and disconnect cleanup.

## Usage

The default base URL is `http://127.0.0.1:9996`. `/health` is unauthenticated. When client auth is enabled, it protects `/v1/*` and `/admin/*`; `/dashboard` serves the console shell.

### Authentication and credentials

There are two separate key layers:

- **Client access.** `CURSOR_BRIDGE_AUTH` accepts `on` or `off`. It defaults to `on` when `CURSOR_BRIDGE_API_KEY` is set, and to `off` with a startup warning when that key is unset. Explicit `CURSOR_BRIDGE_AUTH=on` without `CURSOR_BRIDGE_API_KEY` fails startup. Requests can use `Authorization: Bearer <key>` or `x-api-key: <key>`.
- **Cursor access.** `CURSOR_API_KEY` is the Cursor Dashboard -> API Keys credential for headless hosts. Additional credentials can be created in `/dashboard`, assigned weights, enabled or disabled, and stored in the mode-0600 dashboard config. Auth failures put only the failed credential into cooldown and trigger one retry on another available credential.

### API surface

| Endpoint                                     | Use                                                                     |
| -------------------------------------------- | ----------------------------------------------------------------------- |
| `GET /health`                                | Redacted bridge, backend, workspace, and credential state.              |
| `GET /dashboard`                             | Browser management console.                                             |
| `GET /v1/models`                             | Curated models from the active backend.                                 |
| `POST /v1/chat/completions`                  | OpenAI-compatible completion, including SSE streaming and tools.        |
| `GET /admin/config` or `PATCH /admin/config` | Read or hot-update redacted settings, credentials, and model overrides. |

### Request examples

Non-streaming:

```bash
curl -sS http://127.0.0.1:9996/v1/chat/completions \
  -H "Authorization: Bearer $CURSOR_BRIDGE_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "composer-2.5",
    "messages": [{"role": "user", "content": "Reply exactly: OK"}]
  }'
```

Streaming with usage:

```bash
curl -N -sS http://127.0.0.1:9996/v1/chat/completions \
  -H "Authorization: Bearer $CURSOR_BRIDGE_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "composer-2.5",
    "stream": true,
    "stream_options": {"include_usage": true},
    "messages": [{"role": "user", "content": "Count from 1 to 10"}]
  }'
```

Observed response fields:

```text
object: chat.completion
choices[].message: assistant content or tool_calls
usage: prompt_tokens, completion_tokens, total_tokens
stream terminator: data: [DONE]
```

`cursor-api` maps upstream turn usage into the three token fields. `cursor-cli` uses reported usage when available and estimates usage from text only when Cursor omits it.

### Tool calls

The bridge validates declared tool schemas and matching tool history before it returns a completion.

| Mode         | Request setting                                                | Behavior                                                          |
| ------------ | -------------------------------------------------------------- | ----------------------------------------------------------------- |
| `auto`       | `tool_choice: "auto"`                                          | Let the model decide whether to call a declared tool.             |
| `single`     | `parallel_tool_calls: false`                                   | Return at most one allowed tool call.                             |
| `parallel`   | `parallel_tool_calls: true`                                    | Allow multiple indexed tool calls in one response.                |
| `sequential` | Matching assistant and `tool` messages                         | Continue a tool conversation with validated call IDs and results. |
| `forced`     | `tool_choice: { type: "function", function: { name: "..." } }` | Select one declared function.                                     |
| `required`   | `tool_choice: "required"`                                      | Require at least one declared tool call.                          |
| `none`       | `tool_choice: "none"`                                          | Suppress tool calls and return ordinary text.                     |

### Dashboard

Open `http://127.0.0.1:9996/dashboard` to manage the running bridge. The console shows status, active backend, credential state, and model state. It supports add, update, weight, enable, disable, and delete actions for managed credentials, plus per-model and bulk model family toggles. Full API keys are never returned to the console.

The model policy enables top-tier families by default and hides other discovered models until an override is set. The policy patterns cover `composer-2.5`, `cursor-grok-4.6-*`, `claude-opus-5-*`, `claude-sonnet-5-*`, `claude-fable-5-*`, `gpt-5.6-(sol|terra|luna)-*`, `kimi-k3-*`, `glm-5.2-*`, `default`, and `auto`.

## How it works

1. **Load configuration.** `.env` and the dashboard JSON are read, then host, port, client auth, workspace mode, model policy, and credentials are resolved.
2. **Select a backend.** `auto` loads descriptors, checks Cursor authentication, probes `GetServerConfig`, and chooses headless `cursor-api`; if that path is not usable, it selects an executable `cursor-agent`, `agent`, or `cursor` CLI.
3. **Route credentials.** The direct backend uses weighted credentials, retries an auth failure once on another available credential, and tracks cooldown and recovery state.
4. **Discover and curate models.** The active backend supplies models, then the policy applies default family rules and dashboard overrides before `/v1/models` or completion dispatch.
5. **Validate the request.** The server normalizes OpenAI messages, checks tool history and JSON Schema arguments, and rejects disabled models before upstream work.
6. **Run and stream.** `cursor-api` sends the `agent.v1` Connect-RPC sequence, while `cursor-cli` runs Cursor in a disposable `chat-only` workspace by default; both map completion usage, and the server emits OpenAI-shaped JSON or SSE.
7. **Recover.** In `auto`, auth, protocol, and thresholded transport failures switch to CLI when available; after cooldown, a probe can restore `cursor-api`.

## Repository layout

```text
src/                    TypeScript server, backends, dashboard, and model policy
src/backend/cursor-api/ headless Connect-RPC backend and descriptor snapshot
scripts/                descriptor extraction and e2e smoke test
tests/                   Vitest coverage for auth, routing, models, tools, and SSE
docs/assets/banner.svg  README hero banner
```

## Current limitations

- **Unofficial protocol.** Cursor can change the reverse-engineered `agent.v1` service or its bundle; re-run `npm run extract-protos` after a `cursor-agent` update, or force `CURSOR_BRIDGE_BACKEND=cursor-cli`.
- **Local network boundary.** The default bind is `127.0.0.1`; keep it on localhost or a trusted tailnet, and keep client auth enabled when a private reverse proxy exposes it.
- **Tool streaming boundary.** When tools are declared, model text is buffered until Cursor completes so tool markers can be converted safely; omit tools when incremental content matters.
- **Cursor boundary.** Both real backends consume Cursor quota, and `cursor-api` may carry account or terms risk despite local execution; plan quota use and choose the CLI path when needed.

## License

The project license is to be declared before publication.

---

<p align="center"><em>Cursor AI Bridge, keep the bridge local.</em></p>
