<p align="right">
  English · <a href="README.ko.md">한국어</a>
</p>

# Cursor AI Bridge

A local HTTP proxy that exposes Cursor Agent through a small OpenAI-compatible API. It is intended for localhost or a trusted private network, not the public internet.

## API and behavior

- `GET /health` - unauthenticated bridge/backend status.
- `GET /dashboard` - unauthenticated read-only status page.
- `GET|PATCH /admin/config` - authenticated redacted configuration and hot updates for credentials/model overrides.
- `GET /v1/models` - authenticated, curated model list discovered from the active backend.
- `POST /v1/chat/completions` - authenticated non-streaming or SSE chat completions.
- OpenAI function tools support `auto`, `required`, `none`, forced function choices, parallel-call control, validated tool history, and JSON Schema argument validation. Client-declared function names are returned unchanged. Invalid model arguments get one corrective model retry.
- Non-tool streaming forwards Cursor `stream-json --stream-partial-output` assistant fragments incrementally. Tool-mode streaming buffers assistant text until completion, converts an authoritative `[TOOL_CALLS: ...]` marker into indexed OpenAI `tool_calls`, and prevents marker text from leaking into content deltas. `stream_options.include_usage` emits a final `choices: []` usage chunk.
- Cursor children receive an environment allowlist and have combined output caps. Global/per-key concurrency limits, request abort propagation, process-group termination, timeout escalation, temporary chat-only workspaces, and same-workspace serialization bound runtime access.

`/v1/*` fails closed when the client API key is not configured. Authentication accepts `Authorization: Bearer <key>` or `x-api-key: <key>`. Malformed and invalid requests use OpenAI-style error envelopes.

## Requirements

- Node.js 22+ and npm
- An installed cursor-agent bundle plus Cursor credentials for the default headless-first `auto` mode
- A logged-in Cursor CLI/Agent executable when automatic fallback is desired
- macOS, Linux, or WSL

The `mock` backend does not require Cursor and is intended for local development and unit tests.

## Install and run

```bash
git clone <repository-url> cursor-ai-bridge
cd cursor-ai-bridge
npm install
cp .env.example .env
npm run build
npm start
```

The default address is `http://127.0.0.1:9996`. Backend mode defaults to `auto`: startup verifies descriptors and credentials, probes `GetServerConfig` with a short timeout, and selects fully headless `cursor-api` when all three succeed. Otherwise it selects an executable `cursor-agent`, `agent`, or `cursor` CLI. If neither path is usable, startup fails with both attempted reasons. Set `CURSOR_BRIDGE_BACKEND=cursor-api` or `cursor-cli` to force one path.

### Fully headless `cursor-api` backend

`cursor-api` talks directly to Cursor's Connect-RPC service and never starts the Cursor CLI. First extract a compact local descriptor snapshot from your installed cursor-agent bundle, then build:

```bash
CURSOR_BRIDGE_CURSOR_BIN="$HOME/.local/bin/cursor-agent" npm run extract-protos
npm run build
CURSOR_BRIDGE_BACKEND=cursor-api npm start
```

The generated `src/backend/cursor-api/proto-descriptors.json` is gitignored and copied into `dist` by the build. Runtime code does not import the proprietary bundle. `CURSOR_API_KEY` is one independently routed credential (`env`); additional weighted credentials can be stored in the mode-0600 dashboard config. If none exist, authentication retains the single-credential `CURSOR_AUTH_TOKEN`/macOS Keychain behavior (`system`). Auth failures cool down only the failed credential and retry once on another available credential. This routing affects `cursor-api` only; `cursor-cli` and `mock` keep their own login behavior. `CURSOR_BRIDGE_CURSOR_API_ENDPOINT` and `CURSOR_BRIDGE_CURSOR_AGENT_ENDPOINT` override the two protocol destinations; the legacy `CURSOR_API_ENDPOINT` remains accepted for api2.

**Running without the CLI installed (headless-only hosts).** `auto` uses `cursor-api` alone when no `cursor-agent` binary exists, and startup fails only if the API path is also unusable. Two prerequisites replace the CLI on such hosts: (1) a descriptor snapshot — run `npm run extract-protos` once on any machine that has cursor-agent, copy the generated `proto-descriptors.json` over, and point `CURSOR_BRIDGE_CURSOR_API_DESCRIPTORS` at it; (2) env credentials — set `CURSOR_API_KEY` or `CURSOR_AUTH_TOKEN`, because the macOS Keychain token only exists where the Cursor CLI logged in.

In `auto` mode, auth rejection, an outdated-client/protocol error, or three consecutive transport failures flips the active backend to CLI and logs a warning. HTTP 429 and ordinary bad-model/request errors do not flip. After the cooldown, the next request probes cursor-api and recovers it on success. `/health` reports configured mode, active backend, fallback availability, fatal counter, cooldown, and last flip reason.

Wire-parity note: startup sends the CLI's AI-relevant unary sequence and minimal empty `TrackEvents`/`SubmitLogs` batches. The captured CLI sent analytics even with `x-ghost-mode: true`; bundle inspection showed ghost/privacy mode does not suppress these operational buffers, so they are retained without inventing event or log content. Each fresh Run uses the CLI's persisted-agent-key behavior equivalently: a random 32-byte (64-hex) blob key scoped to that fresh conversation.

**Risk notice:** this is an unofficial, version-sensitive Cursor protocol. Using it may violate Cursor's terms or put the account at risk. Force `CURSOR_BRIDGE_BACKEND=cursor-cli` to bypass the direct protocol.

Example request:

```bash
curl -sS http://127.0.0.1:9996/v1/chat/completions \
  -H "Authorization: Bearer $CURSOR_BRIDGE_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "composer-2.5",
    "messages": [{"role": "user", "content": "Reply exactly: OK"}]
  }'
```

Streaming request:

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

OpenAI text content-part arrays are flattened for the text-only CLI backend. Image and unsupported typed blocks are replaced with explicit omission placeholders.

Model curation is enforced for every backend. By default the bridge enables Composer 2.5, Cursor Grok 4.6 variants, Claude 5 Opus/Sonnet/Fable variants, GPT-5.6 Sol/Terra/Luna variants, Kimi K3 variants, GLM 5.2 variants, `default`, and `auto`. All other discovered models are hidden and rejected unless enabled with a dashboard `modelOverrides` entry.

## Configuration

| Variable                                | Default         | Purpose                                                                                                      |
| --------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------ |
| `CURSOR_BRIDGE_HOST`                    | `127.0.0.1`     | HTTP bind address. Keep local unless protected by trusted network controls.                                  |
| `CURSOR_BRIDGE_PORT`                    | `9996`          | HTTP port.                                                                                                   |
| `CURSOR_BRIDGE_API_KEY`                 | unset           | Client-facing key required by `/v1/*`; unset returns `503 configuration_error`.                              |
| `CURSOR_BRIDGE_BACKEND`                 | `auto`          | Headless-first `auto`, forced `cursor-cli`/`cursor-api`, or test-only `mock`.                                |
| `CURSOR_BRIDGE_DEFAULT_MODEL`           | `composer-2.5`  | Request default; also prepended to discovered models when absent.                                            |
| `CURSOR_BRIDGE_WORKSPACE_MODE`          | `chat-only`     | `chat-only` uses a disposable workspace and `--mode ask`; `real-workspace` opts into the configured project. |
| `CURSOR_BRIDGE_REAL_WORKSPACE`          | unset           | Existing directory required in `real-workspace` mode.                                                        |
| `CURSOR_BRIDGE_CURSOR_BIN`              | `cursor`        | Cursor executable name or absolute path.                                                                     |
| `CURSOR_BRIDGE_CURSOR_TIMEOUT_MS`       | `120000`        | Per-command timeout, accepted from 1,000 to 600,000 ms.                                                      |
| `CURSOR_BRIDGE_TERMINATION_GRACE_MS`    | `750`           | Delay between process-group `SIGTERM` and `SIGKILL`, accepted from 1 to 30,000 ms.                           |
| `CURSOR_BRIDGE_MAX_OUTPUT_BYTES`        | `8388608`       | Maximum combined stdout/stderr bytes per Cursor child.                                                       |
| `CURSOR_BRIDGE_MAX_CONCURRENCY`         | `8`             | Maximum global in-flight chat completions.                                                                   |
| `CURSOR_BRIDGE_MAX_CONCURRENCY_PER_KEY` | `4`             | Maximum in-flight completions per authenticated key.                                                         |
| `CURSOR_BRIDGE_CHILD_ENV_ALLOW`         | unset           | Comma-separated exact extra environment names passed to Cursor children.                                     |
| `CURSOR_AUTH_TOKEN`                     | Keychain        | Direct bearer token for `cursor-api`; macOS Keychain is used when unset.                                     |
| `CURSOR_API_KEY`                        | unset           | First-class env credential exchanged for an access token by `cursor-api`.                                    |
| `CURSOR_BRIDGE_DASHBOARD_CONFIG`        | user config dir | Dashboard JSON path; defaults to `~/.config/cursor-ai-proxy-bridge/dashboard.json`.                          |
| `CURSOR_BRIDGE_CREDENTIAL_COOLDOWN_MS`  | `300000`        | Auth-failed cursor-api credential cooldown before lazy recovery.                                             |
| `CURSOR_API_ENDPOINT`                   | api2 Cursor URL | Legacy optional api2 override.                                                                               |
| `CURSOR_BRIDGE_CURSOR_API_ENDPOINT`     | api2 Cursor URL | api2 override; takes precedence over the legacy variable.                                                    |
| `CURSOR_BRIDGE_CURSOR_AGENT_ENDPOINT`   | discovered      | Agent Run endpoint override, bypassing the discovered agent URL.                                             |
| `CURSOR_BRIDGE_AUTO_PROBE_TIMEOUT_MS`   | `5000`          | Startup and recovery `GetServerConfig` probe timeout.                                                        |
| `CURSOR_BRIDGE_AUTO_COOLDOWN_MS`        | `60000`         | CLI fallback cooldown before cursor-api is probed again.                                                     |
| `CURSOR_BRIDGE_AUTO_FATAL_THRESHOLD`    | `3`             | Consecutive transport failures before auto mode flips to CLI.                                                |

Cursor children otherwise receive only normal runtime variables, `XDG_*`, upstream `CURSOR_*`, and `NODE_COMPILE_CACHE`; bridge controls and unrelated secrets are excluded. Neither workspace mode passes `--force` or `--yolo`.

## Workspace and network safety

`chat-only` is the default and runs each request in a disposable directory with Cursor ask mode. `real-workspace` exposes the selected directory to Cursor's writable default agent mode and must be an explicit opt-in. Requests sharing the same resolved real workspace are serialized.

Keep the default localhost bind. If remote access is necessary, use a trusted VPN/tailnet or private reverse proxy and a strong client key. The dashboard never displays the key or Cursor credentials.

## Development

```bash
npm run verify
npm audit --omit=dev
```

`verify` runs type checking, lint, format checking, the isolated single-worker Vitest suite, and a production build.

### Real end-to-end smoke tests

Run this only with a logged-in Cursor Agent after the build/unit gates are green; it consumes real Cursor quota and normally takes about 3-4 minutes:

```bash
CURSOR_BRIDGE_CURSOR_BIN=/absolute/path/to/cursor-agent npm run extract-protos
CURSOR_BRIDGE_BACKEND=auto npm run test:e2e
CURSOR_BRIDGE_CURSOR_BIN=/absolute/path/to/cursor-agent CURSOR_BRIDGE_BACKEND=cursor-cli npm run test:e2e
```

The zero-dependency Node smoke test boots `dist/index.js` on an ephemeral localhost port and checks auth, chat, tool modes/history/validation, SSE timing/usage/tool calls, malformed requests, and disconnect cleanup. It exits nonzero unless every row passes. It is intentionally not part of `npm run verify`.

## Limitations

- Tool delegation relies on a prompt-level `[TOOL_CALLS: ...]` contract. It is validated by the bridge but remains model-dependent.
- Streaming requests that declare tools intentionally buffer model text until Cursor completes. Their content/tool-call TTFB is therefore not incremental; requests without tools stream incrementally.
- Cursor thinking deltas are consumed but not exposed through the OpenAI response.
- The `cursor-cli` path follows local CLI latency and state. The `cursor-api` path is unofficial, may break when Cursor changes its bundle or service, and requires re-running `npm run extract-protos` after an agent update.
- Both real backends consume Cursor quota; `cursor-api` may carry account/terms risk despite running locally.

## Future

When Cursor ships an official chat-completions endpoint, it should replace the unofficial direct protocol while retaining the HTTP compatibility and validation boundary.

## License

MIT.
