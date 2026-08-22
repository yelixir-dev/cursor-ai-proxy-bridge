<p align="center">
  <img src="docs/assets/banner.svg" alt="Cursor AI Bridge, OpenAI-compatible Cursor proxy" width="880">
</p>

<p align="center">
  <strong>Headless 경로와 CLI fallback을 함께 제공하는 OpenAI-compatible Cursor access.</strong>
</p>

<p align="center">
  <img alt="Node.js 22+" src="https://img.shields.io/badge/Node.js-22%2B-b57920">
  <img alt="TypeScript 6.x" src="https://img.shields.io/badge/TypeScript-6.x-1f6f78">
  <img alt="OpenAI-compatible API" src="https://img.shields.io/badge/API-OpenAI--compatible-9f4d2e">
</p>

<!-- README-I18N:START -->

[English](./README.md) | **한국어**

<!-- README-I18N:END -->

**[Cursor AI Bridge](https://github.com/yelixir-dev/cursor-ai-proxy-bridge)**는 Node.js 22+와 TypeScript로 만든 로컬 proxy입니다. Cursor Agent에 `/v1/chat/completions`와 `/v1/models`의 OpenAI-compatible surface를 제공하며, headless `cursor-api`와 `cursor-cli` 두 backend 사이를 기본 `auto` 모드로 라우팅합니다.

[기능](#기능) · [설치](#설치) · [사용법](#사용법) · [동작 방식](#동작-방식) · [레포지토리 구조](#레포지토리-구조) · [현재 한계](#현재-한계) · [라이선스](#라이선스)

## 기능

- **OpenAI-compatible 경로.** `GET /v1/models`는 policy로 선별한 model 목록을 노출하고, `POST /v1/chat/completions`는 일반 요청과 streaming 요청을 받습니다.
- **Headless 우선, CLI 준비.** Headless-direct `cursor-api` backend는 runtime에 CLI가 필요하지 않으며 unofficial reverse-engineered `agent.v1` Connect-RPC protocol을 사용합니다. `cursor-cli`가 fallback으로 남고 `auto`는 failover 후 recovery probe를 수행합니다.
- **SSE와 실제 usage.** Chat completion은 server-sent event로 stream되며 `prompt_tokens`, `completion_tokens`, `total_tokens`를 response에 담습니다. `cursor-api`는 실제 upstream turn usage를 매핑하고 `cursor-cli`는 Cursor가 usage를 생략할 때 report된 값 또는 문서화된 estimate를 사용합니다.
- **제어 가능한 tool call.** single, parallel, sequential, forced, required, auto, none 모드를 지원하고, bridge 경계에서 tool history와 JSON Schema argument를 검증합니다.
- **가중치 기반 credential.** `CURSOR_API_KEY`와 dashboard credential을 weight로 라우팅합니다. 인증 실패가 나면 실패한 credential만 cooldown하고, 사용 가능한 다른 credential로 한 번 retry한 뒤 cooldown이 끝나면 lazy recovery합니다.
- **선별된 model family.** Composer 2.5, Cursor Grok 4.6, Claude 5 Opus, Sonnet, Fable, GPT-5.6 Sol, Terra, Luna, Kimi K3, GLM 5.2, `default`, `auto`를 policy로 활성화하며, dashboard override로 다른 discovered model을 노출하거나 숨길 수 있습니다.
- **로컬 관리 console.** `/dashboard`에서 bridge와 backend status를 보고, 관리 credential CRUD를 수행하며, model family toggle을 bulk enable 또는 disable할 수 있습니다.

## 설치

Node.js 22+와 npm이 필요합니다. 레포지토리의 기존 npm workflow로 설치합니다.

```bash
git clone https://github.com/yelixir-dev/cursor-ai-proxy-bridge.git
cd cursor-ai-proxy-bridge
npm install
cp .env.example .env
npm run build
npm start
```

기본 주소는 `http://127.0.0.1:9997`입니다. `CURSOR_BRIDGE_API_KEY`를 설정한 뒤 `CURSOR_BRIDGE_AUTH=on`을 사용하세요. client key가 없으면 auth 기본값은 `off`이고 startup warning이 기록됩니다. `CURSOR_BRIDGE_BACKEND=auto`가 기본값이며, `cursor-api` 또는 `cursor-cli`로 설정해 backend를 강제할 수 있습니다.

### Runtime timeout

전체 Run 상한과 무출력 watchdog은 서로 독립적인 설정입니다.

| Variable                          | 기본값   | 용도                                                                                 |
| --------------------------------- | -------- | ------------------------------------------------------------------------------------ |
| `CURSOR_BRIDGE_CURSOR_TIMEOUT_MS` | `300000` | Reasoning과 multi-tool round를 포함한 단일 upstream Cursor Run의 절대 상한입니다.    |
| `CURSOR_BRIDGE_RUN_IDLE_MS`       | `30000`  | 설정된 시간 동안 model interaction frame이 하나도 없으면 해당 Run을 실패 처리합니다. |

`composer-2.5` 같은 reasoning-heavy 모델은 cold start와 multi-tool 작업 중 기존 120초 상한을 넘어서 stream이 잘리고 일부 tool call이 유실될 수 있습니다. 전체 상한은 idle watchdog보다 길게 유지하세요. 기본 300초는 활성 작업이 끝날 시간을 제공하고, 30초 watchdog은 실제로 멈춘 Run을 계속 빠르게 종료합니다. 두 값은 `.env`에서 각각 독립적으로 바꿀 수 있습니다.

모든 HTTP response에는 bridge log entry와 일치하는 `x-request-id`가 포함됩니다. Cursor Run timeout의 JSON 또는 SSE error payload에는 upstream `request_id`도 포함됩니다. Timeout log는 마지막 interaction 종류와 경과 시간, output byte, terminal-frame 상태, stream reset code, HTTP/2 GOAWAY metadata를 기록하므로 열린 채 terminal이 오지 않은 Run과 닫힌 transport를 구분할 수 있습니다.

### Hermes provider 설정 (Composer)

`composer-2.5`와 `composer-2.5-fast`는 cold-start와 thinking 구간이 길 수 있습니다. Hermes를 client로 사용할 때는 서로 독립적인 두 상한을 모두 충분히 길게 설정해야 합니다.

1. **Bridge Run timeout.** `CURSOR_BRIDGE_CURSOR_TIMEOUT_MS`는 전체 upstream Run의 상한입니다.
2. **Hermes stale-stream timeout.** `stale_timeout_seconds`는 Hermes가 유효한 stream output을 기다리는 상한입니다. `composer-*`를 reasoning model로 분류하지 않는 Hermes 버전에서는 provider 기본값(일반적으로 180초)이 적용됩니다.

둘 중 하나라도 먼저 만료되면 client가 `Response truncated — stream ended before completion`을 보고하거나, 일부 전송된 tool call을 버리거나, model이 아직 thinking 중인데 reconnect할 수 있습니다.

먼저 bridge를 설정합니다.

```bash
# Bridge .env
CURSOR_BRIDGE_CURSOR_TIMEOUT_MS=300000
CURSOR_BRIDGE_RUN_IDLE_MS=30000

# Linux systemd 예시: 재시작한 뒤 실행 중인 process environment를 확인합니다.
systemctl --user restart cursor-ai-proxy-bridge
tr '\0' '\n' <"/proc/$(systemctl --user show -p MainPID --value cursor-ai-proxy-bridge)/environ" |
  grep CURSOR_BRIDGE_CURSOR_TIMEOUT_MS
```

그다음 Hermes custom provider 전체의 stale-stream timeout을 높입니다. Hermes 내장 Grok provider는 이미 600초를 사용하지만, custom provider에는 명시적으로 설정해야 합니다.

```bash
hermes config set providers.custom.stale_timeout_seconds 600
hermes config get providers.custom.stale_timeout_seconds
```

동일한 `~/.hermes/config.yaml` 설정은 다음과 같습니다.

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

`providers.custom.stale_timeout_seconds`는 custom provider 전체에 적용됩니다. `base_url`은 bridge에 직접 연결하는 `http://127.0.0.1:9997/v1`이나, `composer-2.5`와 `composer-2.5-fast`를 이 bridge로 라우팅하는 LiteLLM gateway(예: `http://127.0.0.1:9995/v1`)를 사용하세요.

### Headless 호스트용 descriptor snapshot

`cursor-api`는 Cursor service에 직접 연결하며 descriptor snapshot이 필요합니다. Private repository에 현재 snapshot을 포함하므로 headless 호스트는 `cursor-agent` 설치 없이 clone, build, 실행할 수 있습니다.

Cursor가 protocol을 변경하면 `cursor-agent`가 설치된 머신에서 추적 중인 snapshot을 갱신합니다.

```bash
CURSOR_BRIDGE_CURSOR_BIN="$HOME/.local/bin/cursor-agent" npm run extract-protos
npm run build
CURSOR_BRIDGE_BACKEND=cursor-api npm start
```

추적 중인 `src/backend/cursor-api/proto-descriptors.json`은 build 때 `dist`로 복사됩니다. `CURSOR_BRIDGE_CURSOR_API_DESCRIPTORS`로 외부 snapshot을 지정하는 override도 유지됩니다. Headless 인증에는 Cursor Dashboard -> API Keys에서 발급한 `CURSOR_API_KEY`를 설정합니다. `CURSOR_AUTH_TOKEN`도 사용할 수 있으며, env 또는 dashboard credential이 없으면 system credential이 macOS Keychain을 사용할 수 있습니다.

### npm scripts

| Command                  | Purpose                                                                        |
| ------------------------ | ------------------------------------------------------------------------------ |
| `npm run dev`            | `src/index.ts`를 `tsx` watch 모드로 실행합니다.                                |
| `npm run build`          | TypeScript를 compile하고 descriptor snapshot이 있으면 복사합니다.              |
| `npm start`              | `dist/index.js`를 시작합니다.                                                  |
| `npm run clean`          | `dist`를 삭제합니다.                                                           |
| `npm run extract-protos` | 설치된 `cursor-agent` bundle에서 도달 가능한 protocol descriptor를 추출합니다. |
| `npm run typecheck`      | 파일을 emit하지 않고 TypeScript를 검사합니다.                                  |
| `npm run lint`           | ESLint를 실행합니다.                                                           |
| `npm run format`         | Prettier로 레포지토리를 format합니다.                                          |
| `npm run format:check`   | Prettier로 레포지토리 format을 검사합니다.                                     |
| `npm run test`           | 한 worker로 Vitest suite를 실행합니다.                                         |
| `npm run test:e2e`       | build한 뒤 실제 backend를 대상으로 Node smoke test를 실행합니다.               |
| `npm run verify`         | typecheck, lint, format check, test, build를 실행합니다.                       |

### End to end smoke test

사용 가능한 Cursor backend가 있는 상태에서 `npm run test:e2e`를 실행하세요. 실제 Cursor quota를 사용하며 authentication, chat, tools, SSE, malformed request, disconnect cleanup을 검사합니다.

## 사용법

기본 base URL은 `http://127.0.0.1:9997`입니다. `/health`는 인증이 필요 없습니다. Client auth가 켜지면 `/v1/*`와 `/admin/*`을 보호하며, `/dashboard`는 console shell을 제공합니다.

### Authentication 및 credential

서로 다른 두 key 계층이 있습니다.

- **Client access.** `CURSOR_BRIDGE_AUTH`는 `on` 또는 `off`를 받습니다. 기본값은 `on`이며 `CURSOR_BRIDGE_API_KEY`가 설정된 경우입니다. key가 없으면 startup warning과 함께 `off`가 됩니다. `CURSOR_BRIDGE_AUTH=on`을 `CURSOR_BRIDGE_API_KEY` 없이 명시하면 startup에 실패합니다. 요청은 `Authorization: Bearer <key>` 또는 `x-api-key: <key>`를 사용할 수 있습니다.
- **Cursor access.** `CURSOR_API_KEY`는 headless host용 Cursor Dashboard -> API Keys credential입니다. `/dashboard`에서 추가 credential을 만들고 weight를 지정하거나 enable, disable할 수 있으며 mode-0600 dashboard config에 저장됩니다. 인증 실패는 해당 credential만 cooldown에 넣고 사용 가능한 다른 credential로 한 번 retry합니다.

### 모델

`GET /v1/models`는 Cursor의 effort별 긴 variant slug 대신 간결한 통합 모델 표면을 제공합니다. Fast와 thinking mode는 별도 모델 ID로 유지하고, reasoning 강도는 OpenAI-compatible `reasoning_effort` 요청 필드로 선택합니다.

| Family       | 노출되는 모델 ID                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------- |
| Composer 2.5 | `composer-2.5`, `composer-2.5-fast`                                                                           |
| Fable 5      | `fable-5`, `fable-5-thinking`                                                                                 |
| Sonnet 5     | `sonnet-5`, `sonnet-5-thinking`                                                                               |
| Opus 5       | `opus-5`, `opus-5-fast`, `opus-5-thinking`, `opus-5-thinking-fast`                                            |
| GPT-5.6      | `gpt-5.6-sol`, `gpt-5.6-sol-fast`, `gpt-5.6-terra`, `gpt-5.6-terra-fast`, `gpt-5.6-luna`, `gpt-5.6-luna-fast` |
| Grok 4.6     | `grok-4.6`, `grok-4.6-fast`                                                                                   |
| 기타         | `kimi-k3`, `glm-5.2`, 그리고 Cursor 계정이 제공할 때의 `default` 또는 `auto`                                  |

지원 effort 이름은 `none`, `low`, `medium`, `high`, `xhigh`, `max`이며, 선택한 계정과 family에 실제로 존재하는 variant가 적용됩니다. 기본값은 `medium`이고 medium variant가 없는 `kimi-k3`와 `glm-5.2`는 `high`가 기본입니다. 요청한 effort가 없으면 family 기본값 또는 다른 가용 variant로 fallback합니다.

`claude-opus-5-thinking-max-fast`, `cursor-grok-4.6-high`, `gpt-5.6-sol-xhigh-fast` 같은 기존 Cursor slug도 요청에서 계속 사용할 수 있습니다. 기존 dashboard override는 startup과 configuration update 때 통합 ID로 자동 migrate됩니다.

```json
{
  "model": "opus-5-thinking-fast",
  "reasoning_effort": "max",
  "messages": [{ "role": "user", "content": "Reply exactly: OK" }]
}
```

### API surface

| Endpoint                                       | Use                                                                         |
| ---------------------------------------------- | --------------------------------------------------------------------------- |
| `GET /health`                                  | Redacted bridge, backend, workspace, credential state를 반환합니다.         |
| `GET /dashboard`                               | Browser management console입니다.                                           |
| `GET /v1/models`                               | Active backend의 curated model을 반환합니다.                                |
| `POST /v1/chat/completions`                    | SSE streaming과 tool을 포함한 OpenAI-compatible completion입니다.           |
| `GET /admin/config` 또는 `PATCH /admin/config` | Redacted setting, credential, model override를 조회하거나 hot-update합니다. |

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

관찰되는 response field는 다음과 같습니다.

```text
object: chat.completion
choices[].message: assistant content or tool_calls
usage: prompt_tokens, completion_tokens, total_tokens
stream terminator: data: [DONE]
```

`cursor-api`는 upstream turn usage를 세 token field로 매핑합니다. `cursor-cli`는 사용 가능한 경우 report된 usage를 사용하고, Cursor가 usage를 주지 않을 때만 text에서 usage를 추정합니다.

### Tool calls

Bridge는 completion을 반환하기 전에 선언된 tool schema와 일치하는 tool history를 검증합니다.

| Mode         | Request setting                                                | Behavior                                                  |
| ------------ | -------------------------------------------------------------- | --------------------------------------------------------- |
| `auto`       | `tool_choice: "auto"`                                          | Model이 선언된 tool을 호출할지 결정합니다.                |
| `single`     | `parallel_tool_calls: false`                                   | 허용된 tool call을 최대 하나 반환합니다.                  |
| `parallel`   | `parallel_tool_calls: true`                                    | 하나의 response에서 여러 indexed tool call을 허용합니다.  |
| `sequential` | 일치하는 assistant와 `tool` message                            | 검증된 call ID와 result로 tool conversation을 이어갑니다. |
| `forced`     | `tool_choice: { type: "function", function: { name: "..." } }` | 선언된 function 하나를 선택합니다.                        |
| `required`   | `tool_choice: "required"`                                      | 선언된 tool call을 하나 이상 요구합니다.                  |
| `none`       | `tool_choice: "none"`                                          | Tool call을 억제하고 일반 text를 반환합니다.              |

Bridge는 tool-history follow-up에서 OpenAI 표준인 `assistant.content: null`을 받고, replay가 가능하도록 `tool_calls`와 함께 `content: ""`를 반환합니다. `content`를 문자열로만 검증하는 LiteLLM 같은 앞단 proxy는 이 replay를 `messages[N].content`에서 400으로 거절하고 이 process까지 요청을 보내지 않습니다. 그 ingress에서 `null`을 `""`로 바꾸고 `tool_calls[].id`는 그대로 두세요.

### Dashboard

실행 중인 bridge를 관리하려면 `http://127.0.0.1:9997/dashboard`를 여세요. Console에서 status, active backend, credential state, model state를 확인할 수 있습니다. 관리 credential의 add, update, weight, enable, disable, delete를 지원하며, model별 toggle과 model family bulk toggle도 제공합니다. 전체 API key는 console로 반환되지 않습니다.

Dashboard에는 `/v1/models`가 사용하는 선별된 통합 모델 목록이 표시되며, 명시적인 override로 현재 비활성화된 row도 포함됩니다. 각 row는 모델이 default policy 또는 override로 활성화됐는지 보여주며, 관리자는 기존 Cursor slug를 쓰지 않고 해당 override를 변경할 수 있습니다.

## 동작 방식

1. **설정을 읽습니다.** `.env`와 dashboard JSON을 읽고 host, port, client auth, workspace mode, model policy, credential를 결정합니다.
2. **Backend를 선택합니다.** `auto`는 descriptor, Cursor authentication, `GetServerConfig` probe를 확인하고 headless `cursor-api`를 선택합니다. 사용할 수 없으면 실행 가능한 `cursor-agent`, `agent`, `cursor` CLI를 찾습니다.
3. **Credential를 라우팅합니다.** Direct backend는 weight credential을 사용하고, auth failure를 다른 credential로 한 번 retry하며 cooldown과 recovery state를 기록합니다.
4. **Model을 발견하고 선별합니다.** Active backend가 model을 제공하면 policy가 default family rule과 dashboard override를 적용한 뒤 `/v1/models`와 completion dispatch에 사용합니다.
5. **Request를 검증합니다.** Server는 OpenAI message를 normalize하고 tool history와 JSON Schema argument를 검사하며 disabled model을 upstream 작업 전에 거부합니다.
6. **실행하고 stream합니다.** `cursor-api`는 `agent.v1` Connect-RPC sequence를 보내고, `cursor-cli`는 기본적으로 disposable `chat-only` workspace에서 Cursor를 실행합니다. 두 backend 모두 completion usage를 매핑하고 server는 OpenAI 형태의 JSON 또는 SSE를 보냅니다.
7. **복구합니다.** `auto`에서 auth, protocol, threshold를 넘은 transport failure가 발생하면 CLI가 있을 때 CLI로 전환하고, cooldown 뒤 probe가 성공하면 `cursor-api`를 복원할 수 있습니다.

## 레포지토리 구조

```text
src/                    TypeScript server, backends, dashboard, and model policy
src/backend/cursor-api/ headless Connect-RPC backend and descriptor snapshot
scripts/                descriptor extraction and e2e smoke test
tests/                   Vitest coverage for auth, routing, models, tools, and SSE
docs/assets/banner.svg  README hero banner
```

## 현재 한계

- **비공식 protocol.** Cursor가 reverse-engineered `agent.v1` service나 bundle을 바꿀 수 있습니다. `cursor-agent` update 뒤 또는 bridge update가 outdated descriptor snapshot을 보고할 때 `npm run extract-protos`를 다시 실행하거나 `CURSOR_BRIDGE_BACKEND=cursor-cli`를 강제하세요.
- **로컬 network 경계.** 기본 bind는 `127.0.0.1`입니다. localhost 또는 신뢰하는 tailnet에 유지하고, private reverse proxy가 노출할 때는 client auth도 유지하세요.
- **Tool streaming 경계.** Tool을 선언하면 marker를 안전하게 변환하기 위해 Cursor가 끝날 때까지 model text를 buffer합니다. Incremental content가 중요하면 tool을 선언하지 마세요.
- **앞단 proxy의 `content: null`.** Sequential OpenAI client는 tool-call assistant를 `content: null`로 다시 보냅니다. 이 bridge는 그 형태를 받습니다. LiteLLM 등 ingress가 여전히 `messages[N].content`에서 400을 내면 proxy schema를 고치거나 거기서 `null`을 `""`로 정규화하세요.
- **Cursor 경계.** 두 real backend 모두 Cursor quota를 사용하며, `cursor-api`는 local 실행이어도 account 또는 약관 위험을 가질 수 있습니다. Quota를 계획하고 필요하면 CLI 경로를 선택하세요.

## 라이선스

프로젝트 라이선스는 공개 전에 선언될 예정이며 현재 상태는 "to be declared"입니다.

---

<p align="center"><em>Cursor AI Bridge, bridge는 로컬에 둡니다.</em></p>
