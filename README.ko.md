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

**[Cursor AI Bridge](https://github.com/yelixir-dev/cursor-ai-proxy-bridge)**는 Node.js 22+와 TypeScript로 만든 로컬 proxy입니다. Cursor Agent에 `/v1/chat/completions`와 `/v1/models`의 OpenAI-compatible surface를 제공하며, headless `cursor-api`와 `cursor-cli` 두 backend 사이를 기본 `auto` 모드로 라우팅합니다. 2026-09-05 Linux 검증에서는 인증 worker를 미리 준비한 profile로 설치된 CLI `2026.09.02-c22c1a3`와 `composer-2.5`의 strict profile 시나리오 네 개를 통과했습니다.

[기능](#기능) · [설치](#설치) · [사용법](#사용법) · [동작 방식](#동작-방식) · [레포지토리 구조](#레포지토리-구조) · [현재 한계](#현재-한계) · [라이선스](#라이선스)

## 기능

- **OpenAI-compatible 경로.** `GET /v1/models`는 policy로 선별한 model 목록을 노출하고, `POST /v1/chat/completions`는 일반 요청과 streaming 요청을 받습니다.
- **Headless 우선, CLI 준비.** Headless-direct `cursor-api` backend는 runtime에 CLI가 필요하지 않으며 unofficial reverse-engineered `agent.v1` Connect-RPC protocol을 사용합니다. `cursor-cli`가 fallback으로 남고 `auto`는 failover 후 recovery probe를 수행합니다.
- **SSE와 실제 usage.** Chat completion은 server-sent event로 stream되며 `prompt_tokens`, `completion_tokens`, `total_tokens`를 response에 담습니다. `cursor-api`는 실제 upstream turn usage를 매핑하고 `cursor-cli`는 Cursor가 usage를 생략할 때 report된 값 또는 문서화된 estimate를 사용합니다.
- **제어 가능한 tool call.** single, parallel, sequential, forced, required, auto, none 모드를 지원하고, bridge 경계에서 tool history와 JSON Schema argument를 검증합니다.
- **가중치 기반 credential.** `CURSOR_API_KEY`와 dashboard credential을 weight로 라우팅합니다. 인증 실패가 나면 실패한 credential만 cooldown하고, 사용 가능한 다른 credential로 한 번 retry한 뒤 cooldown이 끝나면 lazy recovery합니다.
- **선별된 model family.** Composer 2.5, Cursor Grok 4.6, Claude 5 Opus, Sonnet, Fable, GPT-5.6 Sol, Terra, Luna, Kimi K3, GLM 5.2, `default`, `auto`를 policy로 활성화하며, dashboard override로 다른 discovered model을 노출하거나 숨길 수 있습니다.
- **로컬 관리 console.** `/dashboard`에서 bridge와 backend status를 보고, 관리 credential CRUD를 수행하며, model family toggle을 bulk enable 또는 disable할 수 있습니다.

### 설치된 CLI 검증 (2026-09-05)

Linux 검증에서 설치된 원본 CLI `2026.09.02-c22c1a3`와 `composer-2.5`를 대상으로
chat, parallel tools, sequential tools, cancellation과 bridge recovery 네 가지
strict full-profile 비교가 모두 통과했습니다. 각각 `differences: []`를 기록했고
양쪽 행동 검증도 통과했습니다. 설치된 bundle의 schema로 비교하며 bridge에만
repository 필드 예외를 허용하지 않습니다.

Parallel은 두 tool result를 모두 반환합니다. Sequential은 첫 결과를 두 번째 call에
사용하고 bridge HTTP 세 round가 하나의 Run을 재사용합니다. Cancellation은 양쪽
upstream stream을 닫습니다. Recovery는 native CLI가 아닌 같은 bridge server에서
확인했습니다.

이 결과의 범위는 **격리된 환경에서 인증 worker를 미리 준비한 profile**입니다.
명시적 승인을 받아 harness가 격리된 home에 전용 `0600` token 파일을 생성하며,
`/getRepositoryInfo` 성공 후 CLI 측정을 시작합니다. 기존 로그인 저장소는 건드리지
않습니다. 임시 credential 파일 네 개는 모두 삭제됐고 기록된 child PID 22개는 모두
종료 상태였으며 cleanup receipt 46개가 모두 통과했습니다.

통제된 HTTP 회귀 검증은 **resume 20/20**, **credential isolation 10/10**을
통과했습니다. 최종 `npm run verify`는 **112개 파일 / 1,102개 테스트**와 typecheck,
lint, formatting, strict check, build를 통과했습니다. 이는 해당 검증 기록이며 다른
계정, model 또는 CLI 버전의 결과를 보장하지 않습니다.

범위와 이력은 [Parity 상태](docs/PARITY-STATUS.md)를 참고하세요. 로컬 비공개 근거는
`.omo/evidence/linux-ready-20260905-auth/final-aggregate.json`과 같은 근거 디렉터리의
`review-verify.log`에 있습니다. `.omo/`는 commit하지 않습니다. 이전 macOS 검증과
8월 benchmark는 과거 기록이며 현재 Linux 결과의 근거가 아닙니다.
이 결과는 cold-start 시간의 동등성, 확률적으로 생성되는 응답 stream의 byte 단위
동일성, 모든 대화형 CLI 기능의 지원을 **입증하지 않습니다**.

### 모델 context window

`GET /v1/models`는 선별된 모든 model에 `context_window`, `context_length`, `max_context_length`를 반환합니다.

`cursor-api`에서는 bridge가 실제 실행할 **live variant**의 window를 사용합니다. Cursor는 같은 legacy slug를 standard와 max-mode variant로 각각 제공하며 선택된 variant의 `context`가 실제 window를 결정합니다. `context=1m`이면 `1000000`으로 노출됩니다. 이 계정에서 관측한 대상은 `opus-5-fast`와 `opus-5-thinking-fast`입니다.

아래 표는 Composer, Grok, Kimi, GLM처럼 `context`가 없거나 discovery에 연결하지 못할 때 사용하는 문서 기반 fallback입니다.

| 모델 family     | 노출 context  | Cursor 출처                                                                                                 |
| --------------- | ------------- | ----------------------------------------------------------------------------------------------------------- |
| Composer 2.5    | 200,000       | [Cursor Docs](https://cursor.com/docs/models/cursor-composer-2-5)                                           |
| Claude Opus 5   | 300,000       | [Cursor Docs](https://cursor.com/docs/models/claude-opus-5)                                                 |
| Claude Sonnet 5 | 300,000       | [Cursor Docs](https://cursor.com/docs/models/claude-sonnet-5)                                               |
| Claude Fable 5  | 300,000       | [Cursor Docs](https://cursor.com/docs/models/claude-fable-5)                                                |
| GPT-5.6 Sol     | 272,000       | [Cursor Docs](https://cursor.com/docs/models/gpt-5-6-sol)                                                   |
| GPT-5.6 Terra   | 272,000       | [Cursor Docs](https://cursor.com/docs/models/gpt-5-6-terra)                                                 |
| GPT-5.6 Luna    | 272,000       | [Cursor Docs](https://cursor.com/docs/models/gpt-5-6-luna)                                                  |
| Grok 4.6        | 256,000       | [Cursor Docs](https://cursor.com/docs/models/grok-4-6)                                                      |
| Kimi K3         | 200,000       | [Cursor Docs](https://cursor.com/docs/models/kimi-k3)                                                       |
| GLM 5.2         | 200,000       | [Cursor Docs](https://cursor.com/docs/models/glm-5-2)                                                       |
| `default`       | 설정된 기본값 | 위 표에서 설정된 model의 행으로 결정                                                                        |
| `auto`          | 200,000       | 보수적인 proxy 하한; [Cursor Router](https://cursor.com/docs/cursor-router) 는 고정 context card가 없습니다 |

기존 effort, thinking, fast slug는 family 값을 따릅니다. 명시적인 dashboard override로만 노출된 model은 Cursor 공식 context card가 없으면 기존 값을 유지합니다.

일부 family의 최대 1M token은 기본값이 아닌 별도의 max-mode variant입니다. Bridge는 임의로 window를 넓히지 않고 선택한 variant의 값을 노출하므로 client는 `context_window`를 기준으로 입력 크기를 정할 수 있습니다.

#### Max Mode context window

Cursor는 parameter가 있는 family를 standard와 `isMaxMode` variant로 제공하며 둘은 `context`만 다릅니다. 아래 값은 Ultra 계정과 `cursor-agent` 2026.08.25에서 `aiserver.v1.AvailableModelsResponse` (`useModelParameters: true`)를 읽은 기록으로 홍보 수치가 아닌 실제 응답 값입니다.

| 모델 family     | Standard variant | Max Mode variant | 제공된 Max Mode variant 수 |
| --------------- | ---------------- | ---------------- | -------------------------- |
| Composer 2.5    | `context` 없음   | 없음             | 0                          |
| Claude Opus 5   | 300,000          | **1,000,000**    | 16                         |
| Claude Sonnet 5 | 300,000          | **1,000,000**    | 10                         |
| Claude Fable 5  | 300,000          | **1,000,000**    | 10                         |
| GPT-5.6 Sol     | 272,000          | **1,000,000**    | 6                          |
| GPT-5.6 Terra   | 272,000          | **1,000,000**    | 6                          |
| GPT-5.6 Luna    | 272,000          | **1,000,000**    | 6                          |
| Grok 4.6        | `context` 없음   | 없음             | 0                          |
| Kimi K3         | `context` 없음   | 없음             | 0                          |
| GLM 5.2         | `context` 없음   | 없음             | 0                          |

Max Mode variant가 있어도 bridge가 기본으로 선택하는 것은 아닙니다. `GetUsableModels`가 legacy slug별 계정 variant를 결정하며 아래 policy를 켜지 않으면 bridge는 그 결정을 따릅니다.

`context` 없이 제공되는 family에는 Max Mode variant가 없으며 위 문서 기반 표를 사용합니다.

#### Max Mode 선택

`CURSOR_BRIDGE_MAX_MODE_DEFAULT`는 `true` 또는 `false`만 허용하며 다른 값은 추측하지 않고 startup을 실패 처리합니다.

```bash
CURSOR_BRIDGE_MAX_MODE_DEFAULT=true
```

`/dashboard`의 **Max Mode 기본값**과 admin API에서도 변경할 수 있으며 재시작 없이 다음 요청부터 적용됩니다:

```bash
curl -sS -X PATCH http://127.0.0.1:9997/admin/config \
  -H "Authorization: Bearer $CURSOR_BRIDGE_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"maxModeDefault": true}'
```

활성화하면 계정에 `isMaxMode` variant가 있는 id는 해당 variant를 선택하고 없으면 standard를 사용합니다. 기준 계정의 측정값입니다:

| 노출 id        | Policy 꺼짐 | Policy 켜짐                |
| -------------- | ----------- | -------------------------- |
| `sonnet-5`     | 300,000     | **1,000,000**              |
| `opus-5`       | 300,000     | **1,000,000**              |
| `fable-5`      | 300,000     | **1,000,000**              |
| `gpt-5.6-sol`  | 272,000     | **1,000,000**              |
| `kimi-k3`      | 200,000     | 200,000 (max variant 없음) |
| `composer-2.5` | 200,000     | 200,000 (max variant 없음) |

`reasoning_effort`는 별도 설정이며 Max Mode를 켜지 않습니다. `reasoning_effort: "max"`는 현재 context tier의 가장 강한 effort를 선택하므로 policy가 꺼져 있으면 standard-context variant를 사용합니다.

`GET /v1/models`는 client가 tier를 구별할 수 있도록 각 항목에 표시합니다:

```json
{ "id": "sonnet-5", "is_max_mode": true, "context_window": 1000000 }
```

`GET /admin/config`는 policy와 각 노출 id가 선택하는 variant를 반환합니다:

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

#### Downstream router 동기화 (LiteLLM)

Downstream의 `model_info.max_input_tokens`가 bridge와 다르면 입력이 조용히 잘리거나 upstream에서 거부될 수 있습니다. `GET /v1/models`의 `context_window`는 실제 실행할 variant를 나타내므로 수치를 수동 관리하지 말고 이 값을 router 설정의 기준으로 사용하세요.

```bash
curl -sS http://127.0.0.1:9997/v1/models \
  -H "Authorization: Bearer $CURSOR_BRIDGE_API_KEY" |
  jq -r '.data[] | "\(.id)\t\(.context_window)\t\(.is_max_mode)"'
```

Downstream router 설정 규칙:

- `context_window`를 올림 없이 그대로 `max_input_tokens`에 매핑하세요.
- 같은 id도 policy에 따라 window가 달라지므로 `maxModeDefault` 변경 후 목록을 다시 읽으세요.
- Standard와 Max 항목은 model id로 추측하지 말고 `is_max_mode`로 구분하세요.
- Bridge가 1M으로 보고하지 않는 id에 1M 상한을 설정하지 마세요. Max Mode variant가 없는 Composer, Grok, Kimi, GLM은 policy와 무관하게 1M이 되지 않습니다.

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

| Variable                           | 기본값   | 용도                                                                                            |
| ---------------------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `CURSOR_BRIDGE_CURSOR_TIMEOUT_MS`  | `300000` | Reasoning과 multi-tool round를 포함한 단일 upstream Cursor Run의 절대 상한입니다.               |
| `CURSOR_BRIDGE_RUN_IDLE_MS`        | `30000`  | 설정된 시간 동안 model interaction frame이 하나도 없으면 해당 Run을 실패 처리합니다.            |
| `CURSOR_BRIDGE_RETRY_RUN_TIMEOUT`  | `0`      | Client에 semantic output이 전달되기 전의 전체 Run timeout을 한 번 retry하려면 `1`로 설정합니다. |
| `CURSOR_BRIDGE_RETRY_PROVIDER_5XX` | `0`      | 실험적 옵션: client-visible semantic output 전의 typed provider 5xx를 retry합니다.              |

`composer-2.5` 같은 reasoning-heavy 모델은 cold start와 multi-tool 작업 중 기존 120초 상한을 넘어서 stream이 잘리고 일부 tool call이 유실될 수 있습니다. 전체 상한은 idle watchdog보다 길게 유지하세요. 기본 300초는 활성 작업이 끝날 시간을 제공하고, 30초 watchdog은 실제로 멈춘 Run을 계속 빠르게 종료합니다. 두 값은 `.env`에서 각각 독립적으로 바꿀 수 있습니다.

모든 HTTP response에는 bridge log entry와 일치하는 `x-request-id`가 포함됩니다. Cursor Run timeout의 JSON 또는 SSE error payload에는 upstream `request_id`도 포함됩니다. Timeout log는 Run phase, 전송한 tool result 수, 발표·완료된 external tool call 수, buffered frame, live stream 상태, 마지막 interaction 종류와 경과 시간, output byte, terminal-frame 상태, stream reset code, HTTP/2 GOAWAY metadata를 기록합니다. 성공한 tool-batch trace에도 tool 이름이나 인자 없이 같은 sanitized call count가 포함됩니다. 특히 `phase=resumed_after_tool_results`는 bridge가 client의 tool result를 upstream에 돌려준 뒤 continuation이 멈춘 경우를 식별합니다.

Timeout retry는 client-visible content나 tool-call delta가 전달되기 전에만 안전하므로 opt-in입니다. 활성화하면 동일한 요청 모델을 한 번 retry하며, 자동으로 `composer-2.5-fast`로 바꾸지 않습니다. Semantic output이 하나라도 전달된 뒤의 timeout은 text나 tool execution 중복을 막기 위해 그대로 error로 종료합니다. Retry는 원래 Run이 상한에 도달한 뒤 시작하므로, 300초 timeout 후 12초 만에 재시도가 성공하면 전체 완료 시간은 12초가 아니라 약 312초입니다.

Cursor의 typed `ERROR_PROVIDER_ERROR` metadata는 retry 분류 전에 decode됩니다. Provider HTTP
400을 포함해 명시적인 `isRetryable:false`는 기본적으로 terminal입니다.
`CURSOR_BRIDGE_RETRY_PROVIDER_5XX=1`은 더 좁은 500-599 사례를 실험할 때만 사용하세요. 기존
server retry 최대 3회 제한을 사용하고 requested model과 최초 credential을 유지하며, content
또는 tool-call output이 client에 전달된 뒤에는 retry하지 않습니다. Provider type, retry marker,
provider status, Connect code, upstream Run request ID만 allowlist diagnostics로 노출하며 provider
detail 원문과 임의 metadata는 log나 response에 포함하지 않습니다.

이 flag들을 안전하게 평가하려면 `CURSOR_BRIDGE_TRACE=1`을 설정하세요. 각 request 단계마다 제한된
범위의 redacted JSON 한 줄이 stderr로 기록됩니다: `request_id`, 시도마다 갱신되는
`credential_slot_id` sha256 digest(credential id나 token 절대 포함 안 함), 모든 `run_open`의 upstream
`run_request_id`, policy를 읽은 이후 record의 `retry_provider_5xx` 상태, opt-in이 유발한 retry의
`retry_reason`(`provider_5xx` 또는 `run_timeout`), 그리고 retry 가능한 typed provider 5xx를 하지
않기로 결정했을 때 `upstream_error` record의 `retry_declined`(`flag_off`, `post_visible`,
`retry_limit`). Prompt, provider payload, message, stack은 절대 기록되지 않습니다. 지금까지 실제
운영 환경에서 typed provider 5xx response는 관측된 적이 없습니다. Tracing은 이런 사건이 발생했을
때 측정을 가능하게 할 뿐, 발생 빈도를 높이지 않습니다.

### Hermes provider 설정 (Composer)

`composer-2.5`와 `composer-2.5-fast`는 cold-start와 thinking 구간이 길 수 있습니다. Hermes를 client로 사용할 때는 서로 독립적인 두 상한을 모두 충분히 길게 설정해야 합니다.

1. **Bridge Run timeout.** `CURSOR_BRIDGE_CURSOR_TIMEOUT_MS`는 전체 upstream Run의 상한입니다.
2. **Hermes stale-stream timeout.** `stale_timeout_seconds`는 Hermes가 유효한 stream output을 기다리는 상한입니다. `composer-*`를 reasoning model로 분류하지 않는 Hermes 버전에서는 provider 기본값(일반적으로 180초)이 적용됩니다.

둘 중 하나라도 먼저 만료되면 client가 stream 잘림 오류을 보고하거나, 일부 전송된 tool call을 버리거나, model이 아직 thinking 중인데 reconnect할 수 있습니다.

먼저 bridge를 설정합니다.

```bash
# Bridge .env
CURSOR_BRIDGE_CURSOR_TIMEOUT_MS=300000
CURSOR_BRIDGE_RUN_IDLE_MS=30000

# Linux systemd example: restart and verify the running process environment.
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

### Tool-call 선택과 strict single-call 모드

`tool_choice: "auto"`는 선언된 function 중에서 model이 선택하게 하며 여러 call을 만들 수
있습니다. 정확히 한 function을 호출해야 한다면 named function choice를 사용하세요:

```json
{
  "tool_choice": {
    "type": "function",
    "function": { "name": "read" }
  }
}
```

Bridge는 선택적 요청 필드 `max_tool_calls`(`1`부터 `128`)도 받습니다.
엄격한 단일 call 동작에는 `max_tool_calls: 1`을 사용하세요. Function 하나를 선언하고
`tool_choice: "auto"`를 사용하면 upstream choice를 해당 named function으로 강화합니다.
여러 function을 선언하면 처음 완료된 허용 call을 노출하고 Run을 즉시 park하므로 이후
model이 생성한 builtin은 추가 external OpenAI call이 되지 않습니다.
`parallel_tool_calls: false`의 기존 단일 call 동작도 유지됩니다.

Builtin promotion은 native MCP call과 같은 declared-tool 및 named-choice allowlist를
적용합니다. 선언되지 않았거나 제외된 builtin은 숨은 복구 call로 보관하지 않고
거부합니다. Tool-call ID, 이름, argument byte는 OpenAI response와 SSE 직렬화에서 보존됩니다.

`NODE_DEBUG=cursor-bridge`로 안전한 tool-routing 및 content-boundary metadata를
확인하세요. 승격된 builtin 기록에는 요청 model, reasoning effort, tool choice, 선언된
이름, 시도한 builtin, 승격된 external 이름, call index, Run request ID, origin,
disposition이 포함됩니다. Content 기록은 Cursor upstream과 OpenAI SSE 단계의 chunk
길이 및 앞뒤 whitespace 여부만 포함하며 API key, prompt, 생성 text는 포함하지 않습니다.

### npm scripts

| Command                   | Purpose                                                                        |
| ------------------------- | ------------------------------------------------------------------------------ |
| `npm run dev`             | `src/index.ts`를 `tsx` watch 모드로 실행합니다.                                |
| `npm run build`           | TypeScript를 compile하고 descriptor snapshot이 있으면 복사합니다.              |
| `npm start`               | `dist/index.js`를 시작합니다.                                                  |
| `npm run clean`           | `dist`를 삭제합니다.                                                           |
| `npm run extract-protos`  | 설치된 `cursor-agent` bundle에서 도달 가능한 protocol descriptor를 추출합니다. |
| `npm run typecheck`       | 파일을 emit하지 않고 TypeScript를 검사합니다.                                  |
| `npm run lint`            | ESLint를 실행합니다.                                                           |
| `npm run format`          | Prettier로 레포지토리를 format합니다.                                          |
| `npm run format:check`    | Prettier로 레포지토리 format을 검사합니다.                                     |
| `npm run test`            | 한 worker로 Vitest suite를 실행합니다.                                         |
| `npm run test:e2e`        | build한 뒤 실제 backend를 대상으로 Node smoke test를 실행합니다.               |
| `npm run test:live-tools` | 명시적으로 활성화한 10x live Cursor tool-call model matrix를 실행합니다.       |
| `npm run verify`          | typecheck, lint, format check, strict check, test, build를 실행합니다.         |

### End to end smoke test

사용 가능한 Cursor backend가 있는 상태에서 `npm run test:e2e`를 실행하세요. 실제 Cursor quota를 사용하며 authentication, chat, tools, SSE, malformed request, disconnect cleanup을 검사합니다.

LiteLLM tool-call 회귀 검증은 live matrix에 OpenAI-compatible base URL을 지정해
실행합니다. 지원하는 Cursor model마다 `tool_choice: "auto"` 요청을 순차적으로 열 번
보내며 response당 정확한 `read_file` call 하나만 허용합니다. 실제 quota를 소비하므로
다음 opt-in 없이는 시작하지 않습니다:

```bash
CURSOR_TOOL_MATRIX_LIVE=1 \
CURSOR_TOOL_MATRIX_BASE_URL=http://127.0.0.1:9995 \
CURSOR_TOOL_MATRIX_API_KEY="$YORHA_LITELLM_API_KEY" \
npm run test:live-tools
```

`CURSOR_TOOL_MATRIX_RUNS`는 의도적인 smoke 또는 soak 실행에 맞춰 `1`부터 `100`까지
설정할 수 있습니다. Reporter는 model 이름, run 번호, HTTP status class, error type만
출력하며 credential, prompt, 생성 content, tool argument는 출력하지 않습니다.

## 사용법

기본 base URL은 `http://127.0.0.1:9997`입니다. `/health`는 인증이 필요 없습니다. Client auth가 켜지면 `/v1/*`와 `/admin/*`을 보호하며, `/dashboard`는 console shell을 제공합니다.

### Authentication 및 credential

서로 다른 두 key 계층이 있습니다.

- **Client access.** `CURSOR_BRIDGE_AUTH`는 `on` 또는 `off`를 받습니다. 기본값은 `on`이며 `CURSOR_BRIDGE_API_KEY`가 설정된 경우입니다. key가 없으면 startup warning과 함께 `off`가 됩니다. `CURSOR_BRIDGE_AUTH=on`을 `CURSOR_BRIDGE_API_KEY` 없이 명시하면 startup에 실패합니다. 요청은 `Authorization: Bearer <key>` 또는 `x-api-key: <key>`를 사용할 수 있습니다.
- **Cursor access.** `CURSOR_API_KEY`는 headless host용 Cursor Dashboard -> API Keys credential입니다. `/dashboard`에서 추가 credential을 만들고 weight를 지정하거나 enable, disable할 수 있으며 mode-0600 dashboard config에 저장됩니다. 인증 실패는 해당 credential만 cooldown에 넣고 사용 가능한 다른 credential로 한 번 retry합니다.

Credential 선택과 실패 제외는 독립적인 설정입니다:

| 변수                                   | 값                                              | 기본값                 | 동작                                                                                                                                                 |
| -------------------------------------- | ----------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CURSOR_BRIDGE_CREDENTIAL_ROUTING`     | `weighted_round_robin`, `round_robin`           | `weighted_round_robin` | 가중치 모드는 dashboard weight를 사용합니다. 균등 round-robin은 weight를 무시하고 정상 credential에 분산합니다.                                      |
| `CURSOR_BRIDGE_FAILOVER_ON`            | `auth`, `auth_or_quota`, `auth_or_quota_or_5xx` | `auth`                 | `auth`는 일반 401/403/unauthenticated 실패에 전환합니다. 확장 모드는 billing/quota, 이어서 429/5xx/typed provider `resource_exhausted`를 추가합니다. |
| `CURSOR_BRIDGE_CREDENTIAL_COOLDOWN_MS` | 양의 밀리초                                     | `300000`               | 제외된 credential이 lazy recovery하기 전까지의 시간입니다.                                                                                           |

보수적인 기본값은 기존 동작을 유지합니다. 더 넓은 policy를 선택하지 않으면 quota와
일시적 provider 실패는 선택한 credential에 남습니다. 요청은 content 또는 tool output을
client에 보내기 전에만 최대 한 번 failover합니다. 두 번째 credential도 활성화된 실패
유형으로 실패하면 이후 요청을 위해 cooldown합니다.

`CURSOR_BRIDGE_TRACE=1`에서 credential 전환은 `credential_failover` JSONL을
기록합니다. Hash된 `excluded_credential_slot_id`, `next_credential_slot_id`와
`credential_exclusion_reason`(`auth`, `billing`, `cooldown`)만 포함하며 원본 credential
ID와 key는 기록하지 않습니다. 잘못된 routing 또는 failover 값은 허용 값 목록과 함께
startup을 실패 처리합니다.

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

선언된 tool이 하나뿐이면 `tool_choice: "required"`를 의미상 같은 named-function choice로 내부 강화합니다. 모든 required 요청에서 client에 output이 전달되기 전에 Composer가 Cursor builtin을 선택하면 허용된 external tool 목록을 명시해 한 번 retry합니다. 두 번째에도 builtin을 선택하면 tool이 optional일 때 `tool_choice: "auto"`를 사용하라는 actionable error를 반환하며, builtin 실행을 선언된 function으로 조용히 대체하지 않습니다. Parallel batch는 upstream Run을 park하기 전에 늦게 발표되는 sibling을 1,000ms 동안 기다리며, `CURSOR_BRIDGE_STICKY_SETTLE_MS`로 이 window를 바꿀 수 있습니다. Upstream이 `parallel_tool_calls: false` 요청에 여러 call을 발표하면 bridge는 같은 Run에 보존하고 각 result가 도착할 때마다 OpenAI response 하나당 call 하나씩 노출합니다.

Bridge는 tool-history follow-up에서 OpenAI 표준인 `assistant.content: null`을 받고, replay가 가능하도록 `tool_calls`와 함께 `content: ""`를 반환합니다. `content`를 문자열로만 검증하는 LiteLLM 같은 앞단 proxy는 이 replay를 `messages[N].content`에서 400으로 거절하고 이 process까지 요청을 보내지 않습니다. 그 ingress에서 `null`을 `""`로 바꾸고 `tool_calls[].id`는 그대로 두세요.

Tool-call response는 내부 source `unknown`과 함께 usage 0을 반환할 수 있습니다. Upstream Run이 authoritative token total을 담은 `turnEnded`보다 먼저 `mcpArgs`에서 park되기 때문입니다. Client가 tool result를 제출하면 마지막 continuation이 해당 Run 전체의 `turnEnded` usage를 반환합니다. Bridge는 중간 response의 prompt token을 임의로 추정하지 않습니다.

`CURSOR_BRIDGE_MAX_HELD_RUNS`는 동시에 park할 수 있는 Run 수를 제한합니다(기본값 `128`). `CURSOR_BRIDGE_MAX_OUTPUT_BYTES`는 Run별 raw wire byte와 누적 decoded Connect payload byte를 모두 제한합니다. Timeout diagnostics에는 `outputBytes`와 `decodedOutputBytes`가 함께 포함되므로 compressed expansion과 일반 wire 증가를 구분할 수 있습니다.

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
- **Tool streaming 경계.** Tool을 선언하면 marker를 안전하게 변환하기 위해 Cursor가 끝날 때까지 model text를 buffer합니다. Incremental content가 중요하면 tool을 선언하지 마세요. **앞단 proxy의 `content: null`.** Sequential OpenAI client는 tool-call assistant를 `content: null`로 다시 보냅니다. 이 bridge는 그 형태를 받습니다. LiteLLM 등 ingress가 여전히 `messages[N].content`에서 400을 내면 proxy schema를 고치거나 거기서 `null`을 `""`로 정규화하세요.
- **Cursor 경계.** 두 real backend 모두 Cursor quota를 사용하며, `cursor-api`는 local 실행이어도 account 또는 약관 위험을 가질 수 있습니다. Quota를 계획하고 필요하면 CLI 경로를 선택하세요.

## 라이선스

프로젝트 라이선스는 공개 전에 선언될 예정이며 현재 상태는 "to be declared"입니다.

---

<p align="center"><em>Cursor AI Bridge, bridge는 로컬에 둡니다.</em></p>
