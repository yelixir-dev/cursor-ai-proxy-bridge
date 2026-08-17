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

기본 주소는 `http://127.0.0.1:9996`입니다. `CURSOR_BRIDGE_API_KEY`를 설정한 뒤 `CURSOR_BRIDGE_AUTH=on`을 사용하세요. client key가 없으면 auth 기본값은 `off`이고 startup warning이 기록됩니다. `CURSOR_BRIDGE_BACKEND=auto`가 기본값이며, `cursor-api` 또는 `cursor-cli`로 설정해 backend를 강제할 수 있습니다.

### Headless 호스트용 descriptor snapshot

`cursor-api`는 Cursor service에 직접 연결하며 descriptor snapshot이 필요합니다. `cursor-agent`가 설치된 머신에서 snapshot을 추출하고 build한 뒤 direct backend를 시작합니다.

```bash
CURSOR_BRIDGE_CURSOR_BIN="$HOME/.local/bin/cursor-agent" npm run extract-protos
npm run build
CURSOR_BRIDGE_BACKEND=cursor-api npm start
```

생성된 `src/backend/cursor-api/proto-descriptors.json`은 gitignore되며 build 때 `dist`로 복사됩니다. CLI가 없는 호스트에서는 `npm run extract-protos`를 `cursor-agent`가 있는 머신에서 실행하고 생성된 `proto-descriptors.json`을 복사한 다음 `CURSOR_BRIDGE_CURSOR_API_DESCRIPTORS`를 그 경로로 설정하세요. Headless 인증에는 Cursor Dashboard -> API Keys에서 발급한 `CURSOR_API_KEY`를 설정합니다. `CURSOR_AUTH_TOKEN`도 사용할 수 있으며, env 또는 dashboard credential이 없으면 system credential이 macOS Keychain을 사용할 수 있습니다.

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

기본 base URL은 `http://127.0.0.1:9996`입니다. `/health`는 인증이 필요 없습니다. Client auth가 켜지면 `/v1/*`와 `/admin/*`을 보호하며, `/dashboard`는 console shell을 제공합니다.

### Authentication 및 credential

서로 다른 두 key 계층이 있습니다.

- **Client access.** `CURSOR_BRIDGE_AUTH`는 `on` 또는 `off`를 받습니다. 기본값은 `on`이며 `CURSOR_BRIDGE_API_KEY`가 설정된 경우입니다. key가 없으면 startup warning과 함께 `off`가 됩니다. `CURSOR_BRIDGE_AUTH=on`을 `CURSOR_BRIDGE_API_KEY` 없이 명시하면 startup에 실패합니다. 요청은 `Authorization: Bearer <key>` 또는 `x-api-key: <key>`를 사용할 수 있습니다.
- **Cursor access.** `CURSOR_API_KEY`는 headless host용 Cursor Dashboard -> API Keys credential입니다. `/dashboard`에서 추가 credential을 만들고 weight를 지정하거나 enable, disable할 수 있으며 mode-0600 dashboard config에 저장됩니다. 인증 실패는 해당 credential만 cooldown에 넣고 사용 가능한 다른 credential로 한 번 retry합니다.

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

### Dashboard

실행 중인 bridge를 관리하려면 `http://127.0.0.1:9996/dashboard`를 여세요. Console에서 status, active backend, credential state, model state를 확인할 수 있습니다. 관리 credential의 add, update, weight, enable, disable, delete를 지원하며, model별 toggle과 model family bulk toggle도 제공합니다. 전체 API key는 console로 반환되지 않습니다.

Model policy는 기본적으로 top-tier family를 활성화하고, 다른 discovered model은 override를 설정하기 전까지 숨깁니다. Policy pattern은 `composer-2.5`, `cursor-grok-4.6-*`, `claude-opus-5-*`, `claude-sonnet-5-*`, `claude-fable-5-*`, `gpt-5.6-(sol|terra|luna)-*`, `kimi-k3-*`, `glm-5.2-*`, `default`, `auto`를 대상으로 합니다.

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
- **Cursor 경계.** 두 real backend 모두 Cursor quota를 사용하며, `cursor-api`는 local 실행이어도 account 또는 약관 위험을 가질 수 있습니다. Quota를 계획하고 필요하면 CLI 경로를 선택하세요.

## 라이선스

프로젝트 라이선스는 공개 전에 선언될 예정이며 현재 상태는 "to be declared"입니다.

---

<p align="center"><em>Cursor AI Bridge, bridge는 로컬에 둡니다.</em></p>
