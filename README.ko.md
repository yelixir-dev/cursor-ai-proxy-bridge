<p align="right">
  <a href="README.md">English</a> · 한국어
</p>

# Cursor AI Bridge

Cursor Agent를 작은 OpenAI-compatible API로 노출하는 로컬 HTTP proxy입니다. Public internet이 아니라 localhost 또는 신뢰하는 private network에서 사용하는 도구입니다.

## API와 동작

- `GET /health` - 인증이 필요 없는 bridge/backend 상태.
- `GET /dashboard` - 인증이 필요 없는 read-only 상태 페이지.
- `GET|PATCH /admin/config` - 인증된 redacted 설정 조회 및 credential/model override hot update.
- `GET /v1/models` - active backend에서 검색하고 policy로 선별한 인증 model 목록.
- `POST /v1/chat/completions` - 인증된 non-streaming 또는 SSE chat completion.
- OpenAI function tool에서 `auto`, `required`, `none`, forced function choice, parallel-call 제어, tool history 검증, JSON Schema argument 검증을 지원합니다. Client가 선언한 function name은 변경하지 않습니다. Model argument가 invalid하면 한 번의 corrective model retry를 수행합니다.
- Tool이 없는 streaming은 Cursor `stream-json --stream-partial-output` assistant fragment를 incremental하게 전달합니다. Tool-mode streaming은 완료 시점까지 assistant text를 buffer하고 authoritative `[TOOL_CALLS: ...]` marker를 indexed OpenAI `tool_calls`로 변환하며 marker가 content delta에 유출되지 않게 합니다. `stream_options.include_usage`는 마지막에 `choices: []` usage chunk를 보냅니다.
- Cursor child는 environment allowlist와 stdout/stderr 합산 output cap 안에서 실행됩니다. Global/key별 concurrency limit, request abort 전달, process-group 종료, timeout escalation, 임시 chat-only workspace, 동일 workspace serialization으로 runtime access를 제한합니다.

Client API key가 설정되지 않으면 `/v1/*`는 fail-closed입니다. 인증은 `Authorization: Bearer <key>` 또는 `x-api-key: <key>`를 받습니다. Malformed/invalid request는 OpenAI-style error envelope를 반환합니다.

## 요구 사항

- Node.js 22+ 및 npm
- 기본 headless-first `auto` mode용 cursor-agent bundle과 Cursor credential
- 자동 fallback이 필요할 때 login된 Cursor CLI/Agent executable
- macOS, Linux 또는 WSL

`mock` backend는 Cursor가 필요 없으며 local development와 unit test용입니다.

## 설치와 실행

```bash
git clone <repository-url> cursor-ai-bridge
cd cursor-ai-bridge
npm install
cp .env.example .env
npm run build
npm start
```

기본 주소는 `http://127.0.0.1:9996`입니다. Backend mode 기본값은 `auto`입니다. 시작 시 descriptor, credential, 짧은 timeout의 `GetServerConfig` probe를 확인해 모두 성공하면 headless `cursor-api`를 선택하고, 아니면 executable `cursor-agent`, `agent`, `cursor` CLI로 fallback합니다. 둘 다 사용할 수 없으면 시도한 두 경로의 원인과 함께 시작에 실패합니다. 한 경로를 강제하려면 `CURSOR_BRIDGE_BACKEND=cursor-api` 또는 `cursor-cli`를 설정하십시오.

### 완전한 headless `cursor-api` backend

`cursor-api`는 Cursor CLI process를 시작하지 않고 Connect-RPC service에 직접 연결합니다. 설치된 cursor-agent bundle에서 local descriptor를 먼저 추출한 뒤 build합니다.

```bash
CURSOR_BRIDGE_CURSOR_BIN="$HOME/.local/bin/cursor-agent" npm run extract-protos
npm run build
CURSOR_BRIDGE_BACKEND=cursor-api npm start
```

생성된 `src/backend/cursor-api/proto-descriptors.json`은 gitignore되며 build 때 `dist`로 복사됩니다. Runtime은 proprietary bundle을 import하지 않습니다. `CURSOR_API_KEY`는 독립적으로 routing되는 `env` credential이며 mode-0600 dashboard config에 weighted credential을 추가할 수 있습니다. Credential이 없으면 기존 `CURSOR_AUTH_TOKEN`/macOS Keychain 단일 credential 동작을 `system`으로 유지합니다. Auth failure는 해당 credential만 cooldown하고 사용 가능한 다른 credential로 한 번 retry합니다. 이 routing은 `cursor-api`에만 적용되며 `cursor-cli`와 `mock`은 자체 login을 그대로 사용합니다. 두 목적지는 `CURSOR_BRIDGE_CURSOR_API_ENDPOINT`, `CURSOR_BRIDGE_CURSOR_AGENT_ENDPOINT`로 override할 수 있습니다.

**CLI 없는 호스트에서 실행 (headless-only).** `cursor-agent` binary가 없으면 `auto`는 `cursor-api`만 사용하고, API 경로마저 사용 불가할 때만 시작에 실패합니다. 그런 호스트에서는 두 가지가 CLI를 대체합니다: (1) descriptor 스냅샷 — cursor-agent가 있는 머신에서 `npm run extract-protos`를 한 번 실행해 생성된 `proto-descriptors.json`을 복사하고 `CURSOR_BRIDGE_CURSOR_API_DESCRIPTORS`로 가리키게 합니다. (2) env 자격증명 — macOS Keychain token은 Cursor CLI로 로그인한 머신에만 있으므로 `CURSOR_API_KEY` 또는 `CURSOR_AUTH_TOKEN`을 설정합니다.

`auto` mode에서는 auth 거부, outdated-client/protocol 오류 또는 연속 3회 transport 실패 시 warning을 남기고 CLI로 전환합니다. HTTP 429와 일반 bad request/model 오류는 전환하지 않습니다. Cooldown 뒤 다음 요청에서 cursor-api를 probe해 성공하면 복구합니다. `/health`에는 configured mode, active backend, fallback 가능 여부, fatal counter, cooldown과 마지막 전환 원인이 표시됩니다.

Wire parity를 위해 시작 시 AI 관련 CLI unary sequence와 비어 있는 최소 `TrackEvents`/`SubmitLogs` batch를 보냅니다. Capture에서는 `x-ghost-mode: true`에서도 analytics가 전송되었고 bundle에서도 privacy/ghost mode가 operational buffer를 억제하지 않았으므로, 임의 event/log 내용 없이 method shape만 재현합니다. Fresh Run마다 32-byte random key를 64-hex `x-blob-encryption-key`로 사용합니다.

**위험 고지:** 이 protocol은 unofficial이며 version 변화에 취약합니다. Direct protocol을 우회하려면 `CURSOR_BRIDGE_BACKEND=cursor-cli`를 강제하십시오.

요청 예시:

```bash
curl -sS http://127.0.0.1:9996/v1/chat/completions \
  -H "Authorization: Bearer $CURSOR_BRIDGE_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "composer-2.5",
    "messages": [{"role": "user", "content": "Reply exactly: OK"}]
  }'
```

Streaming 요청:

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

OpenAI text content-part array는 text-only CLI backend에 맞게 flatten합니다. Image와 지원하지 않는 typed block은 명시적인 omission placeholder로 바뀝니다.

Model curation은 모든 backend에 적용됩니다. 기본적으로 Composer 2.5, Cursor Grok 4.6 variant, Claude 5 Opus/Sonnet/Fable variant, GPT-5.6 Sol/Terra/Luna variant, Kimi K3 variant, GLM 5.2 variant, `default`, `auto`만 활성화됩니다. 나머지 검색 model은 dashboard `modelOverrides`에서 활성화하지 않으면 숨겨지고 요청도 거부됩니다.

## 설정

| 변수                                    | 기본값          | 용도                                                                                                         |
| --------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------ |
| `CURSOR_BRIDGE_HOST`                    | `127.0.0.1`     | HTTP bind address. 신뢰하는 network control이 없으면 local로 유지.                                           |
| `CURSOR_BRIDGE_PORT`                    | `9996`          | HTTP port.                                                                                                   |
| `CURSOR_BRIDGE_API_KEY`                 | unset           | `/v1/*`에 필요한 client-facing key. Unset이면 `503 configuration_error`.                                     |
| `CURSOR_BRIDGE_BACKEND`                 | `auto`          | Headless-first `auto`, 강제 `cursor-cli`/`cursor-api`, 또는 test용 `mock`.                                   |
| `CURSOR_BRIDGE_DEFAULT_MODEL`           | `composer-2.5`  | Request default. 검색된 목록에 없으면 목록 앞에도 추가.                                                      |
| `CURSOR_BRIDGE_WORKSPACE_MODE`          | `chat-only`     | `chat-only`는 disposable workspace와 `--mode ask` 사용. `real-workspace`는 설정한 project를 명시적으로 노출. |
| `CURSOR_BRIDGE_REAL_WORKSPACE`          | unset           | `real-workspace` mode에서 필요한 기존 directory.                                                             |
| `CURSOR_BRIDGE_CURSOR_BIN`              | `cursor`        | Cursor executable 이름 또는 absolute path.                                                                   |
| `CURSOR_BRIDGE_CURSOR_TIMEOUT_MS`       | `120000`        | Command별 timeout. 1,000-600,000 ms 범위.                                                                    |
| `CURSOR_BRIDGE_TERMINATION_GRACE_MS`    | `750`           | Process-group `SIGTERM`과 `SIGKILL` 사이 delay. 1-30,000 ms 범위.                                            |
| `CURSOR_BRIDGE_MAX_OUTPUT_BYTES`        | `8388608`       | Cursor child별 stdout/stderr 합산 최대 byte.                                                                 |
| `CURSOR_BRIDGE_MAX_CONCURRENCY`         | `8`             | 전체 in-flight chat completion 최대 수.                                                                      |
| `CURSOR_BRIDGE_MAX_CONCURRENCY_PER_KEY` | `4`             | 인증 key별 in-flight completion 최대 수.                                                                     |
| `CURSOR_BRIDGE_CHILD_ENV_ALLOW`         | unset           | Cursor child에 추가 전달하는 정확한 environment 이름의 comma-separated 목록.                                 |
| `CURSOR_AUTH_TOKEN`                     | Keychain        | `cursor-api`용 direct bearer token. Unset이면 macOS Keychain 사용.                                           |
| `CURSOR_API_KEY`                        | unset           | `cursor-api`가 access token으로 교환하는 first-class env credential.                                         |
| `CURSOR_BRIDGE_DASHBOARD_CONFIG`        | user config dir | Dashboard JSON 경로. 기본값은 `~/.config/cursor-ai-proxy-bridge/dashboard.json`.                             |
| `CURSOR_BRIDGE_CREDENTIAL_COOLDOWN_MS`  | `300000`        | Auth-failed cursor-api credential의 lazy recovery 전 cooldown.                                               |
| `CURSOR_API_ENDPOINT`                   | Cursor api2     | Legacy api2 endpoint override.                                                                               |
| `CURSOR_BRIDGE_CURSOR_API_ENDPOINT`     | Cursor api2     | api2 override. Legacy 변수보다 우선합니다.                                                                   |
| `CURSOR_BRIDGE_CURSOR_AGENT_ENDPOINT`   | discovered      | Discovery 결과 대신 사용할 Agent Run endpoint.                                                               |
| `CURSOR_BRIDGE_AUTO_PROBE_TIMEOUT_MS`   | `5000`          | Startup/recovery `GetServerConfig` probe timeout.                                                            |
| `CURSOR_BRIDGE_AUTO_COOLDOWN_MS`        | `60000`         | cursor-api를 다시 probe하기 전 CLI fallback cooldown.                                                        |
| `CURSOR_BRIDGE_AUTO_FATAL_THRESHOLD`    | `3`             | CLI로 전환하기 전 연속 transport failure 수.                                                                 |

그 외에는 일반 runtime 변수, `XDG_*`, upstream `CURSOR_*`, `NODE_COMPILE_CACHE`만 Cursor child에 전달하며 bridge control과 관련 없는 secret은 제외합니다. 어느 workspace mode도 `--force`나 `--yolo`를 전달하지 않습니다.

## Workspace 및 network 안전

기본 `chat-only`는 각 request를 disposable directory와 Cursor ask mode에서 실행합니다. `real-workspace`는 선택한 directory를 Cursor의 writable default agent mode에 노출하므로 명시적으로 opt-in해야 합니다. 동일한 resolved real workspace를 공유하는 request는 serialize됩니다.

기본 localhost bind를 유지하십시오. Remote access가 필요하면 신뢰하는 VPN/tailnet 또는 private reverse proxy와 강한 client key를 사용하십시오. Dashboard는 key나 Cursor credential을 표시하지 않습니다.

## 개발

```bash
npm run verify
npm audit --omit=dev
```

`verify`는 type check, lint, format check, 격리된 single-worker Vitest suite, production build를 실행합니다.

### 실제 end-to-end smoke test

Build/unit gate가 green이고 Cursor Agent에 login된 경우에만 실행하십시오. 실제 Cursor quota를 사용하며 보통 약 3-4분이 걸립니다.

```bash
CURSOR_BRIDGE_CURSOR_BIN=/absolute/path/to/cursor-agent npm run extract-protos
CURSOR_BRIDGE_BACKEND=auto npm run test:e2e
CURSOR_BRIDGE_CURSOR_BIN=/absolute/path/to/cursor-agent CURSOR_BRIDGE_BACKEND=cursor-cli npm run test:e2e
```

Dependency 없는 Node smoke test가 ephemeral localhost port에서 `dist/index.js`를 실행하고 auth, chat, tool mode/history/validation, SSE timing/usage/tool call, malformed request, disconnect cleanup을 검사합니다. 모든 row가 pass하지 않으면 nonzero로 종료합니다. 의도적으로 `npm run verify`에는 포함하지 않습니다.

## 제한 사항

- Tool delegation은 prompt-level `[TOOL_CALLS: ...]` contract에 의존합니다. Bridge가 결과를 검증하지만 model-dependent라는 성질은 남습니다.
- Tool을 선언한 streaming request는 Cursor 완료까지 model text를 의도적으로 buffer합니다. 따라서 content/tool-call TTFB는 incremental하지 않으며 tool이 없는 request만 incremental하게 stream합니다.
- Cursor thinking delta는 소비하지만 OpenAI response로 노출하지 않습니다.
- `cursor-cli`는 local CLI 상태를 따릅니다. Unofficial `cursor-api`는 Cursor bundle/service 변경 때 깨질 수 있으며 agent update 후 `npm run extract-protos`를 다시 실행해야 합니다.
- 두 real backend 모두 Cursor quota를 사용하며, local 실행이어도 `cursor-api`에는 account/약관 위험이 있을 수 있습니다.

## Future

Cursor가 공식 chat-completions endpoint를 제공하면 HTTP compatibility와 validation boundary는 유지하면서 unofficial direct protocol을 대체해야 합니다.

## License

MIT.
