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

### Model context windows

`GET /v1/models` returns `context_window`, `context_length`, and `max_context_length` for every curated model.

With the `cursor-api` backend these fields are derived from the **live variant** the bridge will actually run: Cursor advertises the same legacy slug twice, once as a standard variant and once as a max-mode variant, and only the resolved variant's `context` parameter states the real window. A model whose resolved variant reports `context=1m` is therefore advertised as `1000000`. On this account that currently applies to `opus-5-fast` and `opus-5-thinking-fast`.

The table below is the documented fallback used when Cursor exposes no `context` parameter for a family (Composer, Grok, Kimi, GLM) or when the backend cannot reach discovery.

| Model family    | Advertised context | Cursor source                                                                                              |
| --------------- | ------------------ | ---------------------------------------------------------------------------------------------------------- |
| Composer 2.5    | 200,000            | [Cursor Docs](https://cursor.com/docs/models/cursor-composer-2-5)                                          |
| Claude Opus 5   | 300,000            | [Cursor Docs](https://cursor.com/docs/models/claude-opus-5)                                                |
| Claude Sonnet 5 | 300,000            | [Cursor Docs](https://cursor.com/docs/models/claude-sonnet-5)                                              |
| Claude Fable 5  | 300,000            | [Cursor Docs](https://cursor.com/docs/models/claude-fable-5)                                               |
| GPT-5.6 Sol     | 272,000            | [Cursor Docs](https://cursor.com/docs/models/gpt-5-6-sol)                                                  |
| GPT-5.6 Terra   | 272,000            | [Cursor Docs](https://cursor.com/docs/models/gpt-5-6-terra)                                                |
| GPT-5.6 Luna    | 272,000            | [Cursor Docs](https://cursor.com/docs/models/gpt-5-6-luna)                                                 |
| Grok 4.6        | 256,000            | [Cursor Docs](https://cursor.com/docs/models/grok-4-6)                                                     |
| Kimi K3         | 200,000            | [Cursor Docs](https://cursor.com/docs/models/kimi-k3)                                                      |
| GLM 5.2         | 200,000            | [Cursor Docs](https://cursor.com/docs/models/glm-5-2)                                                      |
| `default`       | Configured default | Resolved from the configured model's row above                                                             |
| `auto`          | 200,000            | Conservative proxy floor; [Cursor Router](https://cursor.com/docs/cursor-router) has no fixed context card |

Legacy effort, thinking, and fast slugs inherit their family's value. Models exposed only through an explicit dashboard override remain unchanged when Cursor has no official context card.

Cursor documents extended windows "up to 1M tokens" for several families, but the 1M variants are published as separate max-mode variants rather than as the family default. The bridge never upgrades a request to a wider window on its own: it advertises exactly the window of the variant it resolves, so a client that reads `context_window` can fill it safely.

#### Max Mode context windows

Cursor publishes every parameterized family twice: a standard variant and an `isMaxMode` variant that differ only in the `context` parameter. The windows below were read from `aiserver.v1.AvailableModelsResponse` (`useModelParameters: true`) on an Ultra account with `cursor-agent` 2026.08.25, so they are the values Cursor actually serves rather than a marketing figure.

| Model family    | Standard variant       | Max Mode variant | Max Mode variants published |
| --------------- | ---------------------- | ---------------- | --------------------------- |
| Composer 2.5    | no `context` parameter | none             | 0                           |
| Claude Opus 5   | 300,000                | **1,000,000**    | 16                          |
| Claude Sonnet 5 | 300,000                | **1,000,000**    | 10                          |
| Claude Fable 5  | 300,000                | **1,000,000**    | 10                          |
| GPT-5.6 Sol     | 272,000                | **1,000,000**    | 6                           |
| GPT-5.6 Terra   | 272,000                | **1,000,000**    | 6                           |
| GPT-5.6 Luna    | 272,000                | **1,000,000**    | 6                           |
| Grok 4.6        | no `context` parameter | none             | 0                           |
| Kimi K3         | no `context` parameter | none             | 0                           |
| GLM 5.2         | no `context` parameter | none             | 0                           |

A family having a Max Mode variant does not mean the bridge selects it by default. `GetUsableModels` decides, per legacy slug, which of the two variants the account uses, and the bridge follows that decision unless the Max Mode policy below is enabled.

Families advertised without a `context` parameter have no Max Mode variant at all; they fall back to the documented table above.

#### Selecting Max Mode

`CURSOR_BRIDGE_MAX_MODE_DEFAULT` makes the preference explicit. It accepts only `true` or `false`; any other value fails startup rather than being guessed.

```bash
CURSOR_BRIDGE_MAX_MODE_DEFAULT=true
```

The same switch is available in `/dashboard` as **Max Mode 기본값** and over the admin API, both of which apply to the next request without a restart:

```bash
curl -sS -X PATCH http://127.0.0.1:9997/admin/config \
  -H "Authorization: Bearer $CURSOR_BRIDGE_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"maxModeDefault": true}'
```

When enabled, an advertised id resolves to its `isMaxMode` variant if the account publishes one, and falls back to the standard variant when it does not. Measured on the reference account:

| Advertised id  | Policy off | Policy on                |
| -------------- | ---------- | ------------------------ |
| `sonnet-5`     | 300,000    | **1,000,000**            |
| `opus-5`       | 300,000    | **1,000,000**            |
| `fable-5`      | 300,000    | **1,000,000**            |
| `gpt-5.6-sol`  | 272,000    | **1,000,000**            |
| `kimi-k3`      | 200,000    | 200,000 (no max variant) |
| `composer-2.5` | 200,000    | 200,000 (no max variant) |

`reasoning_effort` is a separate axis and never enables Max Mode. `reasoning_effort: "max"` selects the strongest effort variant of whichever context tier is active, so with the policy off it still resolves to a standard-context variant.

`GET /v1/models` marks each entry so a client can tell the tiers apart:

```json
{ "id": "sonnet-5", "is_max_mode": true, "context_window": 1000000 }
```

`GET /admin/config` reports the policy and the variant every advertised id resolves to:

```json
{
  "config": { "maxModeDefault": true },
  "state": {
    "models": [
      {
        "id": "sonnet-5",
        "resolvedVariant": "claude-sonnet-5-medium",
        "isMaxMode": true,
        "contextWindow": 1000000
      }
    ]
  }
}
```

#### Synchronizing a downstream router (LiteLLM)

A downstream `model_info.max_input_tokens` that disagrees with the bridge causes silent truncation or upstream rejection. `GET /v1/models` is the single source of truth: `context_window` always describes the variant the bridge will actually run, so derive the router config from it instead of hand-maintaining numbers.

```bash
curl -sS http://127.0.0.1:9997/v1/models \
  -H "Authorization: Bearer $CURSOR_BRIDGE_API_KEY" |
  jq -r '.data[] | "\(.id)\t\(.context_window)\t\(.is_max_mode)"'
```

Rules for downstream routers:

- Map `context_window` to `max_input_tokens` verbatim; never round it up.
- Re-read the catalogue after changing `maxModeDefault`, because the same id reports a different window under each policy.
- Treat `is_max_mode` as the tier marker when exposing separate standard and Max entries; do not infer the tier from the model id.
- Never configure a 1M limit for an id the bridge does not report as 1M. A family without a Max Mode variant (Composer, Grok, Kimi, GLM) never reaches 1M regardless of the policy.

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

The default address is `http://127.0.0.1:9997`. Set `CURSOR_BRIDGE_API_KEY` before using `CURSOR_BRIDGE_AUTH=on`; when the client key is unset, auth defaults to `off` and startup logs a warning. `CURSOR_BRIDGE_BACKEND=auto` is the default. Set it to `cursor-api` or `cursor-cli` to force a backend.

### Runtime timeouts

The overall Run ceiling and the no-output watchdog are separate controls:

| Variable                           | Default  | Purpose                                                                                    |
| ---------------------------------- | -------- | ------------------------------------------------------------------------------------------ |
| `CURSOR_BRIDGE_CURSOR_TIMEOUT_MS`  | `300000` | Hard ceiling for one upstream Cursor Run, including reasoning and multi-tool rounds.       |
| `CURSOR_BRIDGE_RUN_IDLE_MS`        | `30000`  | Fails a Run that produces no model interaction frames for the configured interval.         |
| `CURSOR_BRIDGE_RETRY_RUN_TIMEOUT`  | `0`      | Set to `1` to retry one overall Run timeout before any semantic output reaches the client. |
| `CURSOR_BRIDGE_RETRY_PROVIDER_5XX` | `0`      | Experimental: retry a typed provider 5xx before client-visible semantic output.            |

Reasoning-heavy models such as `composer-2.5` can exceed the previous 120-second ceiling during cold starts and multi-tool work, truncating the stream and dropping partially emitted tool calls. Keep the overall ceiling above the idle watchdog; the 300-second default gives active work time to finish while the 30-second watchdog still rejects dead Runs quickly. Both values can be overridden independently in `.env`.

Every HTTP response includes an `x-request-id` that matches the bridge log entry. A Cursor Run timeout also includes the upstream `request_id` in the JSON or SSE error payload. The timeout log records the Run phase, tool results sent, external tool calls announced and completed, buffered frames, live stream state, last interaction kind and age, output bytes, terminal-frame state, stream reset code, and any HTTP/2 GOAWAY metadata. Successful tool-batch trace records include the same sanitized call counts without tool names or arguments. In particular, `phase=resumed_after_tool_results` identifies a continuation that stalled after the bridge returned the client's tool result upstream.

Timeout retry is opt-in because replay is safe only before client-visible content or tool-call deltas. When enabled, the bridge retries the same requested model once; it never silently changes to `composer-2.5-fast`. A timeout after any semantic output still ends with an error to prevent duplicate text or tool execution. The retry starts only after the original Run reaches its ceiling, so a 300-second timeout followed by a 12-second successful retry completes in roughly 312 seconds, not 12 seconds.

Cursor's typed `ERROR_PROVIDER_ERROR` metadata is decoded before retry classification. Explicit
`isRetryable:false` remains terminal by default, including provider HTTP 400 responses. Set
`CURSOR_BRIDGE_RETRY_PROVIDER_5XX=1` only to experiment with the narrower 500–599 case. It uses
the existing three-server-retry ceiling, preserves the requested model and originating credential,
and never retries after content or tool-call output reaches the client. Provider type, retry marker,
provider status, Connect code, and upstream Run request ID are emitted as allowlisted diagnostics;
raw provider detail text and arbitrary metadata are not logged or returned.

Set `CURSOR_BRIDGE_TRACE=1` to evaluate these flags safely. Each request stage emits one JSON line
to stderr with only bounded, redacted fields: `request_id`, a per-attempt `credential_slot_id`
sha256 digest (never a credential id or token), the upstream `run_request_id` on every `run_open`,
`retry_provider_5xx` flag state on records emitted after the policy is read, `retry_reason`
(`provider_5xx` or `run_timeout`) on retries driven by the opt-ins, and `retry_declined`
(`flag_off`, `post_visible`, or `retry_limit`) on `upstream_error` records when an eligible typed
provider 5xx was not retried. Prompts, provider payloads, messages, and stacks are never recorded.
Typed provider 5xx responses have not been observed in production captures to date; tracing makes
such events measurable when they occur, it does not make them more likely.

### Hermes provider configuration (Composer)

`composer-2.5` and `composer-2.5-fast` can have a long cold-start and thinking phase. When Hermes is the client, two independent ceilings must allow enough time:

1. **Bridge Run timeout.** `CURSOR_BRIDGE_CURSOR_TIMEOUT_MS` limits the complete upstream Run.
2. **Hermes stale-stream timeout.** `stale_timeout_seconds` limits how long Hermes waits for usable stream output. Hermes versions that do not classify `composer-*` as reasoning models apply the provider default, commonly 180 seconds.

If either ceiling fires first, clients can report `Response truncated — stream ended before completion`, drop partially streamed tool calls, or reconnect while the model is still thinking.

Configure the bridge first:

```bash
# Bridge .env
CURSOR_BRIDGE_CURSOR_TIMEOUT_MS=300000
CURSOR_BRIDGE_RUN_IDLE_MS=30000

# Linux systemd example: restart and verify the running process environment.
systemctl --user restart cursor-ai-proxy-bridge
tr '\0' '\n' <"/proc/$(systemctl --user show -p MainPID --value cursor-ai-proxy-bridge)/environ" |
  grep CURSOR_BRIDGE_CURSOR_TIMEOUT_MS
```

Then raise the Hermes custom provider-wide stale-stream timeout. Hermes' built-in Grok provider already uses 600 seconds, but custom providers must set it explicitly:

```bash
hermes config set providers.custom.stale_timeout_seconds 600
hermes config get providers.custom.stale_timeout_seconds
```

Equivalent `~/.hermes/config.yaml`:

```yaml
providers:
  custom:
    name: YorHa LiteLLM
    base_url: http://127.0.0.1:9997/v1
    key_env: YORHA_LITELLM_API_KEY
    default_model: composer-2.5
    transport: chat_completions
    context_length: 200000
    stale_timeout_seconds: 600
```

`providers.custom.stale_timeout_seconds` applies to the entire custom provider. Point `base_url` directly at the bridge (`http://127.0.0.1:9997/v1`) or at a LiteLLM gateway such as `http://127.0.0.1:9995/v1` that routes `composer-2.5` and `composer-2.5-fast` to this bridge.

### Descriptor snapshot for headless hosts

`cursor-api` connects directly to Cursor's service and needs a descriptor snapshot. The private repository includes the current snapshot, so a headless host can clone, build, and run without installing `cursor-agent`.

When Cursor changes its protocol, refresh the committed snapshot on a machine with `cursor-agent` installed:

```bash
CURSOR_BRIDGE_CURSOR_BIN="$HOME/.local/bin/cursor-agent" npm run extract-protos
npm run build
CURSOR_BRIDGE_BACKEND=cursor-api npm start
```

The tracked `src/backend/cursor-api/proto-descriptors.json` is copied into `dist` by the build. `CURSOR_BRIDGE_CURSOR_API_DESCRIPTORS` remains available for overriding it with an external snapshot. Set `CURSOR_API_KEY` from Cursor Dashboard -> API Keys for headless authentication. `CURSOR_AUTH_TOKEN` is also accepted, and a system credential can use the macOS Keychain when no env or dashboard credential is present.

### Tool-call selection and strict single-call mode

`tool_choice: "auto"` lets the model choose any declared function and can produce more than one
call. Use a named function choice when the request must call one exact function:

```json
{
  "tool_choice": {
    "type": "function",
    "function": { "name": "read" }
  }
}
```

The bridge also accepts the optional `max_tool_calls` request field (`1` through `128`). Set
`max_tool_calls: 1` for strict single-call behavior. When the request declares one function and
uses `tool_choice: "auto"`, this mode strengthens the upstream choice to that named function.
With several declared functions, the first completed allowed call is surfaced and the Run is
parked immediately, so later model-generated builtins cannot become extra external OpenAI calls.
`parallel_tool_calls: false` retains its existing one-call behavior.

Builtin promotion applies the same declared-tool and named-choice allowlist as native MCP calls.
An undeclared or excluded builtin is rejected rather than held as a hidden recovery call. Tool-call
IDs, names, and argument bytes are preserved through OpenAI response and SSE serialization.

Set `NODE_DEBUG=cursor-bridge` to inspect safe tool-routing and content-boundary metadata. Promoted
builtin records include the requested model, reasoning effort, tool choice, declared names,
attempted builtin, promoted external name, call index, Run request ID, origin, and disposition.
Content records include only chunk lengths and leading/trailing whitespace flags at the Cursor
upstream and OpenAI SSE stages. API keys and prompt or generated text are never included.

### npm scripts

| Command                   | Purpose                                                                             |
| ------------------------- | ----------------------------------------------------------------------------------- |
| `npm run dev`             | Watch `src/index.ts` with `tsx`.                                                    |
| `npm run build`           | Compile TypeScript and copy the descriptor snapshot when present.                   |
| `npm start`               | Start `dist/index.js`.                                                              |
| `npm run clean`           | Remove `dist`.                                                                      |
| `npm run extract-protos`  | Extract the reachable protocol descriptors from an installed `cursor-agent` bundle. |
| `npm run typecheck`       | Run TypeScript without emitting files.                                              |
| `npm run lint`            | Run ESLint.                                                                         |
| `npm run format`          | Format the repository with Prettier.                                                |
| `npm run format:check`    | Check repository formatting with Prettier.                                          |
| `npm run test`            | Run the Vitest suite with one worker.                                               |
| `npm run test:e2e`        | Build and run the Node smoke test against a real backend.                           |
| `npm run test:live-tools` | Run the explicitly enabled 10x live Cursor tool-call model matrix.                  |
| `npm run verify`          | Run typecheck, lint, format check, tests, and build.                                |

### End to end smoke test

Run `npm run test:e2e` with a usable Cursor backend. It consumes real Cursor quota and checks authentication, chat, tools, SSE, malformed requests, and disconnect cleanup.

For an opt-in LiteLLM tool-call regression, point the live matrix at an OpenAI-compatible base
URL. It runs ten sequential `tool_choice: "auto"` requests for each supported Cursor model and
accepts only one exact `read_file` call per response. The command refuses to start unless the
quota-consuming opt-in is present:

```bash
CURSOR_TOOL_MATRIX_LIVE=1 \
CURSOR_TOOL_MATRIX_BASE_URL=http://127.0.0.1:9995 \
CURSOR_TOOL_MATRIX_API_KEY="$YORHA_LITELLM_API_KEY" \
npm run test:live-tools
```

`CURSOR_TOOL_MATRIX_RUNS` may be set from `1` through `100` for an intentional smoke or soak run.
The reporter prints only model names, run numbers, HTTP status classes, and error types; it never
prints credentials, prompts, generated content, or tool arguments.

## Usage

The default base URL is `http://127.0.0.1:9997`. `/health` is unauthenticated. When client auth is enabled, it protects `/v1/*` and `/admin/*`; `/dashboard` serves the console shell.

### Authentication and credentials

There are two separate key layers:

- **Client access.** `CURSOR_BRIDGE_AUTH` accepts `on` or `off`. It defaults to `on` when `CURSOR_BRIDGE_API_KEY` is set, and to `off` with a startup warning when that key is unset. Explicit `CURSOR_BRIDGE_AUTH=on` without `CURSOR_BRIDGE_API_KEY` fails startup. Requests can use `Authorization: Bearer <key>` or `x-api-key: <key>`.
- **Cursor access.** `CURSOR_API_KEY` is the Cursor Dashboard -> API Keys credential for headless hosts. Additional credentials can be created in `/dashboard`, assigned weights, enabled or disabled, and stored in the mode-0600 dashboard config. Auth failures put only the failed credential into cooldown and trigger one retry on another available credential.

Credential selection and failure exclusion are independent controls:

| Variable                               | Values                                          | Default                | Behavior                                                                                                                                                             |
| -------------------------------------- | ----------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CURSOR_BRIDGE_CREDENTIAL_ROUTING`     | `weighted_round_robin`, `round_robin`           | `weighted_round_robin` | Weighted mode uses dashboard weights. Equal round-robin ignores weights and spreads picks across every healthy credential.                                           |
| `CURSOR_BRIDGE_FAILOVER_ON`            | `auth`, `auth_or_quota`, `auth_or_quota_or_5xx` | `auth`                 | `auth` rotates ordinary 401/403/unauthenticated failures. The wider modes add billing/quota, then 429/5xx/typed provider `resource_exhausted` failures respectively. |
| `CURSOR_BRIDGE_CREDENTIAL_COOLDOWN_MS` | positive milliseconds                           | `300000`               | Duration applied to an excluded credential before lazy recovery.                                                                                                     |

The conservative default is backward-compatible: quota and transient provider failures stay on the selected credential unless an operator opts into a wider failover policy. A request fails over at most once and only before content or tool output reaches the client. If the second credential fails with an enabled failure class, it is also cooled down for later requests.

With `CURSOR_BRIDGE_TRACE=1`, a credential switch emits a `credential_failover` JSONL record. It contains only hashed `excluded_credential_slot_id` and `next_credential_slot_id` values plus `credential_exclusion_reason` (`auth`, `billing`, or `cooldown`); raw credential IDs and keys are never traced. Invalid routing or failover values fail startup with the accepted value list.

### Models

`GET /v1/models` exposes a compact model surface instead of Cursor's effort-specific variant slugs. Fast and thinking modes remain separate model IDs; reasoning strength is selected with the OpenAI-compatible `reasoning_effort` request field.

| Family       | Advertised model IDs                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------- |
| Composer 2.5 | `composer-2.5`, `composer-2.5-fast`                                                                           |
| Fable 5      | `fable-5`, `fable-5-thinking`                                                                                 |
| Sonnet 5     | `sonnet-5`, `sonnet-5-thinking`                                                                               |
| Opus 5       | `opus-5`, `opus-5-fast`, `opus-5-thinking`, `opus-5-thinking-fast`                                            |
| GPT-5.6      | `gpt-5.6-sol`, `gpt-5.6-sol-fast`, `gpt-5.6-terra`, `gpt-5.6-terra-fast`, `gpt-5.6-luna`, `gpt-5.6-luna-fast` |
| Grok 4.6     | `grok-4.6`, `grok-4.6-fast`                                                                                   |
| Other        | `kimi-k3`, `glm-5.2`, plus `default` or `auto` when the Cursor account advertises them                        |

Supported effort names are `none`, `low`, `medium`, `high`, `xhigh`, and `max`, subject to the variants available for the selected account and family. The default is `medium`; `kimi-k3` and `glm-5.2`, which do not expose a medium variant, default to `high`. If the requested effort is unavailable, the resolver falls back to the family's default or another available variant.

Legacy Cursor slugs such as `claude-opus-5-thinking-max-fast`, `cursor-grok-4.6-high`, and `gpt-5.6-sol-xhigh-fast` remain valid on requests. Legacy dashboard overrides are migrated to their unified IDs at startup and on configuration updates.

```json
{
  "model": "opus-5-thinking-fast",
  "reasoning_effort": "max",
  "messages": [{ "role": "user", "content": "Reply exactly: OK" }]
}
```

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
curl -sS http://127.0.0.1:9997/v1/chat/completions \
  -H "Authorization: Bearer $CURSOR_BRIDGE_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "composer-2.5",
    "messages": [{"role": "user", "content": "Reply exactly: OK"}]
  }'
```

Streaming with usage:

```bash
curl -N -sS http://127.0.0.1:9997/v1/chat/completions \
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

For a single declared tool, `tool_choice: "required"` is strengthened internally to the equivalent named-function choice. For any required request, if Composer selects a Cursor builtin before output reaches the client, the bridge retries once with explicit feedback listing the allowed external tools. A repeated misselection returns an actionable error suggesting `tool_choice: "auto"` when tools are optional; builtin execution is never silently substituted for a declared function. Parallel batches wait 1,000 ms for late sibling announcements before parking the upstream Run; `CURSOR_BRIDGE_STICKY_SETTLE_MS` overrides that window. If upstream announces multiple calls while `parallel_tool_calls` is false, the bridge preserves them on the same Run and exposes one call per OpenAI response as each result arrives.

The bridge accepts OpenAI-standard `assistant.content: null` on a tool-history follow-up and emits `""` with `tool_calls` so a string-only client can replay the assistant message. A front proxy that types `content` as a string only, including some LiteLLM setups, will reject that replay at `messages[N].content` before the request reaches this process. Coerce `null` to `""` at that ingress and leave `tool_calls[].id` unchanged.

A tool-call response can report zero usage with internal source `unknown`: the upstream Run parks on `mcpArgs` before its authoritative `turnEnded` token totals exist. After the client submits the tool result, the final continuation reports the complete `turnEnded` usage for that Run. The bridge does not invent prompt-token estimates for the intermediate response.

`CURSOR_BRIDGE_MAX_HELD_RUNS` caps concurrently parked Runs (default `128`). `CURSOR_BRIDGE_MAX_OUTPUT_BYTES` bounds both raw wire bytes and cumulative decoded Connect payload bytes for each Run. Timeout diagnostics report both `outputBytes` and `decodedOutputBytes`, so compressed expansion and ordinary wire growth remain distinguishable.

### Dashboard

Open `http://127.0.0.1:9997/dashboard` to manage the running bridge. The console shows status, active backend, credential state, and model state. It supports add, update, weight, enable, disable, and delete actions for managed credentials, plus per-model and bulk model family toggles. Full API keys are never returned to the console.

The dashboard shows the curated unified model set used by `/v1/models`, including rows currently disabled by an explicit override. Each row reports whether the model is enabled by the default policy or an override, and lets administrators change that override without using a legacy Cursor slug.

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

- **Unofficial protocol.** Cursor can change the reverse-engineered `agent.v1` service or its bundle; re-run `npm run extract-protos` after a `cursor-agent` update or when a bridge update reports an outdated descriptor snapshot, or force `CURSOR_BRIDGE_BACKEND=cursor-cli`.
- **Local network boundary.** The default bind is `127.0.0.1`; keep it on localhost or a trusted tailnet, and keep client auth enabled when a private reverse proxy exposes it.
- **Tool streaming boundary.** When tools are declared, model text is buffered until Cursor completes so tool markers can be converted safely; omit tools when incremental content matters.
- **Front-proxy `content: null`.** Sequential OpenAI clients replay tool-call assistants with `content: null`. This bridge accepts that shape. If LiteLLM or another ingress still returns 400 on `messages[N].content`, fix the proxy schema or normalize `null` to `""` there.
- **Cursor boundary.** Both real backends consume Cursor quota, and `cursor-api` may carry account or terms risk despite local execution; plan quota use and choose the CLI path when needed.

## License

The project license is to be declared before publication.

---

<p align="center"><em>Cursor AI Bridge, keep the bridge local.</em></p>
