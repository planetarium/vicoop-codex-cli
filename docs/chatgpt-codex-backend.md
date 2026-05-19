# ChatGPT Codex Backend 호출 명세

`vicoop-codex`가 LLM을 호출할 때 실제로 어디로, 무엇을 보내는지에 대한 레퍼런스. 디버깅이나 백엔드 변경 추적 용도.

## 핵심 요약

- **공개 OpenAI API가 아니다.** `api.openai.com/v1/responses`가 아니라 ChatGPT 웹/앱이 내부적으로 쓰는 백엔드를 호출한다.
- **인증은 사용자 ChatGPT OAuth 토큰.** `sk-...` API 키가 아니다.
- **과금은 ChatGPT 구독 한도에서 빠진다.** API 크레딧이 아님.
- 응답은 항상 **SSE 스트림**으로 받는다.

## 엔드포인트

```
POST https://chatgpt.com/backend-api/codex/responses
```

상수 위치: `src/client/responses.ts` 상단의 `CHATGPT_RESPONSES_URL`.

관련 보조 엔드포인트:

```
GET https://chatgpt.com/backend-api/codex/models?client_version=<x.y.z>
```

이 계정에서 허용되는 모델 슬러그 목록을 돌려준다. `400 "... model is not supported"`가 나오면 이 엔드포인트로 현재 유효한 슬러그를 다시 확인할 것.

## 인증

- `Authorization: Bearer <access_token>` — `~/.vicoop-codex/auth.json`의 `tokens.access_token`.
- 토큰은 ChatGPT OAuth(PKCE)로 받음. `src/auth/login.ts`, `src/auth/oauth.ts` 참조.
- JWT라 클레임에서 `chatgpt_plan_type`, `chatgpt_account_id` 등을 꺼낼 수 있음 (`src/auth/jwt.ts`).
- 만료 임박하면 `loadActiveAuth`가 자동으로 refresh, 401이면 `forceRefresh` 후 1회 재시도.

## 요청 헤더

`src/client/responses.ts`의 `buildHeaders`에서 구성한다.

| 헤더 | 값 | 역할 |
|---|---|---|
| `Authorization` | `Bearer <access_token>` | ChatGPT OAuth 토큰 |
| `ChatGPT-Account-ID` | JWT의 `chatgpt_account_id` | 워크스페이스/계정 식별 |
| `Content-Type` | `application/json` | 요청 본문 형식 |
| `Accept` | `text/event-stream` | SSE 스트림으로 응답 받기 |
| `originator` | `codex_cli_rs` | "Codex CLI 클라이언트"로 식별. 없으면 거절될 가능성 |
| `OAI-Product-Sku` | `codex` | 이 CLI가 임의로 박은 헤더. 공식 `codex_cli_rs`에는 없음 — 제거 후보 |
| `User-Agent` | `vicoop-codex-cli/<version>` | 식별용 |

### 공식 codex CLI와의 헤더 차이

공식 `codex_cli_rs`는 추가로 다음 헤더를 보낸다 (`openai/codex` 레포 `codex-rs/core/src/client.rs`, `bearer_auth_provider.rs` 참고).

- `session-id`, `thread-id` — 턴 추적
- `x-codex-installation-id`, `x-codex-window-id` — 설치/창 식별
- `x-codex-beta-features` — 베타 기능 토글
- `x-codex-turn-state`, `x-codex-turn-metadata` — 멀티턴 라우팅
- `X-OpenAI-Fedramp: true` — FedRAMP 계정 한정

지금까지는 이들 없이도 호출이 성공한다(에이전트 기능을 안 쓰니까). 미래에 백엔드가 더 엄격해지면 이 목록이 깨질 후보다.

## 요청 본문

`src/client/responses.ts`의 `buildBody`에서 구성한다. OpenAI "Responses API" 스키마를 따른다.

```jsonc
{
  "model": "gpt-5.3-codex",
  "instructions": "You are a helpful assistant.",
  "input": [
    {
      "type": "message",
      "role": "user",
      "content": [{ "type": "input_text", "text": "say hi" }]
    }
  ],
  "tools": [],
  "tool_choice": "auto",
  "parallel_tool_calls": false,
  "store": false,
  "stream": true,
  "include": [],
  "reasoning": { "effort": "high" }
}
```

### 필드 설명

| 필드 | 타입 | 우리 동작 | 비고 |
|---|---|---|---|
| `model` | string | `-m` 또는 기본 `gpt-5.3-codex` | 백엔드 모델 목록에 있는 슬러그만 허용 |
| `instructions` | string | `-i` 또는 기본 `"You are a helpful assistant."` | **필수.** 비면 `400 "Instructions are required"` |
| `input` | array | positional 인자 한 줄을 user 메시지로 변환 | Responses API의 멀티모달 구조 (텍스트만 사용) |
| `tools` | array | 항상 `[]` | 도구 없음 — 에이전트 X |
| `tool_choice` | string | `"auto"` | tools가 비어있어 무의미하지만 스키마 요구 |
| `parallel_tool_calls` | bool | `false` | 동일 |
| `store` | bool | `false` | 서버 측 대화 이력 저장 안 함 |
| `stream` | bool | `true` | 항상 SSE |
| `include` | array | `[]` | 공식 CLI는 `["reasoning.encrypted_content"]`를 보냄 |
| `reasoning` | object | `-r` 줬을 때만 `{ effort }` 추가 | `low` / `medium` / `high` |

### 본문 호출 예시

```bash
# default
vicoop-codex prompt "say hi"

# -i + -r
vicoop-codex prompt -i "Reply in Korean only." -r high "지구의 둘레는?"

# -m
vicoop-codex prompt -m gpt-5.5 "ping"
```

각각이 만들어내는 본문은 위 표대로 조립된다.

## 응답 헤더

성공 응답(`200 OK`)에는 `Content-Type: text/event-stream`과 함께 다음 `x-codex-*` 메타 헤더가 같이 온다. 요금/사용량 추적용으로 유용.

| 헤더 | 예시 | 의미 |
|---|---|---|
| `x-codex-plan-type` | `plus` | 현재 계정 플랜 (`free` / `plus` / `pro` / `team` / `enterprise`) |
| `x-codex-active-limit` | `premium` | 적용 중인 한도 카테고리 |
| `x-codex-credits-balance` | `""` | 별도 크레딧 잔액(있을 때만) |
| `x-codex-credits-has-credits` | `False` | 크레딧 보유 여부 |
| `x-codex-credits-unlimited` | `False` | 무제한 크레딧 여부 |
| `x-codex-primary-used-percent` | `1` | 1차 윈도 사용량(%) |
| `x-codex-primary-window-minutes` | `300` | 1차 윈도 크기 (분) |
| `x-codex-primary-reset-after-seconds` | `17022` | 1차 윈도 리셋까지 남은 초 |
| `x-codex-primary-reset-at` | `1779187596` | 1차 윈도 리셋 epoch 시각 |
| `x-codex-primary-over-secondary-limit-percent` | `0` | 1차/2차 한도 비율 |
| `x-codex-secondary-used-percent` | `0` | 2차 윈도(주간 등) 사용량(%) |
| `x-codex-secondary-window-minutes` | `10080` | 2차 윈도 크기 (분, 10080=1주) |
| `x-codex-secondary-reset-after-seconds` | `603822` | 2차 윈도 리셋까지 남은 초 |
| `x-codex-secondary-reset-at` | `1779774396` | 2차 윈도 리셋 epoch 시각 |
| `x-models-etag` | `W/"..."` | `/codex/models` 응답 ETag |
| `x-oai-request-id` | `42ab8240-...` | 요청 추적 ID. 문제 보고 시 첨부 권장 |

비고: 우리 CLI(`src/client/responses.ts`)에서는 이 헤더들을 현재 무시한다. 사용량 표시/경고 기능을 붙이고 싶으면 여기서 읽어다 쓰면 된다.

## 응답 스트림 (SSE)

본문은 `text/event-stream`. 각 이벤트는 다음 형태:

```
event: <type>
data: {"type":"<type>", ...}

```

(빈 줄 두 번 = 이벤트 경계.)

이벤트는 항상 `sequence_number`(0부터 증가)를 가지며, 텍스트 한 번 보내는 단순 호출 기준 다음 순서로 나온다.

### 이벤트별 페이로드

#### `response.created` / `response.in_progress`

처음 두 이벤트는 같은 형태로 응답 객체 스냅샷을 보낸다 (`status: "in_progress"`, `output: []`).

```jsonc
{
  "type": "response.created",
  "sequence_number": 0,
  "response": {
    "id": "resp_01edaff025062176016a0bfd0e639081919b148bf3be8bf5e4",
    "object": "response",
    "created_at": 1779170574,
    "status": "in_progress",        // queued | in_progress | completed | failed | cancelled
    "background": false,
    "completed_at": null,
    "error": null,
    "incomplete_details": null,
    "instructions": "You are a helpful assistant. Reply in exactly one short sentence.",
    "max_output_tokens": null,
    "max_tool_calls": null,
    "model": "gpt-5.4",             // 백엔드가 실제 라우팅한 모델 (요청 슬러그와 다를 수 있음!)
    "moderation": null,
    "output": [],
    "parallel_tool_calls": false,
    "previous_response_id": null,
    "prompt_cache_key": "44467f2a-aee3-468b-9ade-05e99d8f4c54",  // 서버가 자동 생성
    "prompt_cache_retention": "24h",
    "reasoning": { "effort": "none", "summary": null },
    "safety_identifier": "user-ahxYFrXj9XWedF9ZNMsgvUvh",
    "service_tier": "auto",
    "store": false,
    "temperature": 1.0,
    "text": { "format": { "type": "text" }, "verbosity": "medium" },
    "tool_choice": "auto",
    "tool_usage": {
      "image_gen": {
        "input_tokens": 0,
        "input_tokens_details": { "image_tokens": 0, "text_tokens": 0 },
        "output_tokens": 0,
        "output_tokens_details": { "image_tokens": 0, "text_tokens": 0 },
        "total_tokens": 0
      },
      "web_search": { "num_requests": 0 }
    },
    "tools": [],
    "top_logprobs": 0,
    "top_p": 0.98,
    "truncation": "disabled",
    "frequency_penalty": 0.0,
    "presence_penalty": 0.0,
    "usage": null,                  // completed 이벤트에서만 채워짐
    "user": null,
    "metadata": {}
  }
}
```

주의: 우리가 `gpt-5.3-codex`로 보내도 `response.model`이 `gpt-5.4`로 라우팅되는 경우가 있다. 백엔드의 모델 별칭/라우팅 규칙. UI에 표기할 땐 응답 쪽 `model`을 신뢰할 것.

#### `response.output_item.added`

새 출력 아이템(메시지/도구호출 등)이 생성됐다는 신호. `item` 내부는 비어 있는 상태.

```jsonc
{
  "type": "response.output_item.added",
  "sequence_number": 2,
  "output_index": 0,
  "item": {
    "id": "msg_01edaff025062176016a0bfd0fcab4819193646a91edaa8643",
    "type": "message",            // message | function_call | reasoning | ...
    "status": "in_progress",
    "phase": "final_answer",      // reasoning | tool_call | final_answer
    "role": "assistant",
    "content": []
  }
}
```

#### `response.content_part.added`

메시지 아이템 안에 새로운 콘텐츠 파트(텍스트/이미지 등)가 시작.

```jsonc
{
  "type": "response.content_part.added",
  "sequence_number": 3,
  "item_id": "msg_...",
  "output_index": 0,
  "content_index": 0,
  "part": {
    "type": "output_text",
    "text": "",
    "annotations": [],
    "logprobs": []
  }
}
```

#### `response.output_text.delta`

스트리밍 텍스트 청크. 텍스트 합치기는 클라이언트가 누적.

```jsonc
{
  "type": "response.output_text.delta",
  "sequence_number": 4,
  "item_id": "msg_...",
  "output_index": 0,
  "content_index": 0,
  "delta": "Hi",                // ← 누적할 조각
  "logprobs": [],
  "obfuscation": "Yrw42Td7n0vQqh"  // 토큰 보안용. 무시해도 됨
}
```

#### `response.output_text.done`

해당 텍스트 파트의 최종 텍스트.

```jsonc
{
  "type": "response.output_text.done",
  "sequence_number": 6,
  "item_id": "msg_...",
  "output_index": 0,
  "content_index": 0,
  "text": "Hi!",                  // delta들을 모두 합친 최종
  "logprobs": []
}
```

#### `response.content_part.done` / `response.output_item.done`

해당 파트/아이템이 완료됐고 최종 형태를 다시 한 번 보내준다.

```jsonc
{
  "type": "response.output_item.done",
  "sequence_number": 8,
  "output_index": 0,
  "item": {
    "id": "msg_...",
    "type": "message",
    "status": "completed",
    "phase": "final_answer",
    "role": "assistant",
    "content": [
      { "type": "output_text", "text": "Hi!", "annotations": [], "logprobs": [] }
    ]
  }
}
```

#### `response.completed`

최종 응답 객체. `created` 이벤트의 객체와 같은 모양이지만 `status: "completed"`, `completed_at`, `output` 채워짐, `usage` 채워짐.

```jsonc
{
  "type": "response.completed",
  "sequence_number": 9,
  "response": {
    "id": "resp_...",
    "status": "completed",
    "completed_at": 1779170576,
    "model": "gpt-5.4",
    "output": [
      {
        "id": "msg_...",
        "type": "message",
        "status": "completed",
        "phase": "final_answer",
        "role": "assistant",
        "content": [
          { "type": "output_text", "text": "Hi!", "annotations": [], "logprobs": [] }
        ]
      }
    ],
    "usage": {
      "input_tokens": 25,
      "input_tokens_details": { "cached_tokens": 0 },
      "output_tokens": 6,
      "output_tokens_details": { "reasoning_tokens": 0 },
      "total_tokens": 31
    },
    "service_tier": "default",
    // ... (나머지는 created 이벤트와 동일 구조)
  }
}
```

#### `response.failed` / `error`

비정상 종료. `response.failed`는 모델/시스템 차원의 실패, `error`는 트랜스포트/검증 오류.

```jsonc
{
  "type": "response.failed",
  "response": {
    "id": "resp_...",
    "status": "failed",
    "error": { "code": "...", "message": "..." }
  }
}
```

또는

```jsonc
{
  "type": "error",
  "error": { "code": "...", "message": "..." }
}
```

### 이벤트 처리 (우리 CLI)

`src/client/sse.ts`의 `parseSse`로 `event:`/`data:`를 분리하고, `runResponse`에서 타입별로 분기.

| `type` | 처리 |
|---|---|
| `response.output_text.delta` | `delta`를 누적하고 `onTextDelta` 콜백 호출 (스트리밍 출력) |
| `response.created` | `response.id`를 `responseId`로 캡처 |
| `response.completed` | `response.usage` 저장 후 `onCompleted` |
| `response.failed` / `error` | `ApiError`로 던짐 |
| 기타 (`output_item.added`, `content_part.*`, `output_text.done`, `output_item.done`, `in_progress`) | `onEvent` 콜백으로만 흘려보냄 — 텍스트 합치기는 delta로 이미 했으므로 무시해도 무방 |

`openai-model` 같은 응답 헤더는 따로 보존하고 결과의 `model`에 채워준다 (현재 코드는 `res.headers.get("openai-model")` 사용).

### 이벤트 시퀀스 요약

도구 호출 없는 단순 텍스트 응답 기준 순서:

```
response.created
response.in_progress
response.output_item.added       (output_index=0, item.type=message)
response.content_part.added      (content_index=0, part.type=output_text)
response.output_text.delta       × N
response.output_text.done
response.content_part.done
response.output_item.done
response.completed               (usage 포함)
```

여러 아이템(예: reasoning + message)이 나오면 `output_index`가 0, 1, ... 로 증가하며 위 패턴이 반복된다.

## 알려진 에러 신호와 원인

| HTTP | `detail` 패턴 | 진짜 원인 |
|---|---|---|
| 400 | `"The 'X' model is not supported when using Codex with a ChatGPT account."` | 모델 슬러그가 현재 백엔드 목록에 없음. `/codex/models`로 다시 확인. (계정 플랜이 Codex를 지원 안 할 때도 같은 메시지가 나오니 `whoami`로 플랜부터 체크) |
| 400 | `"Instructions are required"` | `instructions` 필드가 빈 문자열로 갔거나 누락 |
| 401 | — | `access_token` 만료. 1회 자동 refresh 후 재시도 |
| 403 | — | 계정 권한 없음 (예: Free 플랜) — `whoami`에서 `plan` 확인 |

## 모델 슬러그

고정값이 아니다. 백엔드가 시점에 따라 바꾼다. 본 문서 작성 시점(2026-05) 기준 `/codex/models` 응답에 있던 슬러그:

- `gpt-5.5`
- `gpt-5.4`
- `gpt-5.4-mini`
- `gpt-5.3-codex` (현재 CLI 기본값)
- `gpt-5.2`
- `codex-auto-review`

CLI에 하드코딩된 기본값이 더 이상 목록에 없다면 `src/client/responses.ts`의 `buildBody` 안 `req.model ?? "..."` 디폴트와 `src/index.ts`의 `-m` 옵션 설명 문구를 동시에 갱신해야 한다.

## 에이전트 아님

이 CLI는 위 본문에서 `tools: []`, `store: false`, 멀티턴 루프 없음 — 즉 **에이전트가 아니다**. ChatGPT 구독을 이용한 LLM 단발 호출 래퍼. 에이전트 기능(파일/쉘 도구, 멀티턴, 세션 유지 등)을 붙이려면 본문에 `tools` 채우고 응답에서 `tool_call` 이벤트를 받아 도구 실행 → 결과 다시 `input`에 넣어 재호출하는 루프를 별도로 구현해야 한다.

---

# 비교: 공식 OpenAI Responses API (`sk-...` API 키 사용)

위에서 다룬 ChatGPT 내부 백엔드와 **본문 스키마는 같은 Responses API 계열**이지만, 인증 / 엔드포인트 / 과금 / 가용 모델이 완전히 다르다. `sk-...` API 키로 호출하는 정식 채널의 명세.

## 엔드포인트

```
POST https://api.openai.com/v1/responses
```

보조:
```
GET  https://api.openai.com/v1/responses/{response_id}        # 응답 단건 조회
DELETE https://api.openai.com/v1/responses/{response_id}      # store=true 였던 응답 삭제
GET  https://api.openai.com/v1/responses/{response_id}/input_items  # 입력 아이템 페이징
GET  https://api.openai.com/v1/models                         # 가용 모델 목록
```

## 인증

- `Authorization: Bearer sk-...` — 플랫폼 대시보드에서 발급한 API 키.
- 과금은 **API 크레딧/사용량 한도**에서 빠진다. ChatGPT 구독과 무관.
- 조직/프로젝트 분리 시 추가 헤더 권장:
  - `OpenAI-Organization: org_xxx`
  - `OpenAI-Project: proj_xxx`
- ChatGPT 백엔드와 달리 `ChatGPT-Account-ID`나 `originator` 같은 클라이언트 식별 헤더는 필요 없다.

## 요청 헤더 (최소)

| 헤더 | 값 |
|---|---|
| `Authorization` | `Bearer sk-...` |
| `Content-Type` | `application/json` |
| `Accept` | `text/event-stream` (스트리밍 시) |
| `OpenAI-Organization` | (선택) 조직 분리 시 |
| `OpenAI-Project` | (선택) 프로젝트 분리 시 |

## 요청 본문 — `POST /v1/responses`

필수는 `model`만. 나머지 전부 옵셔널.

| 필드 | 타입 | 설명 |
|---|---|---|
| `model` | string | **필수.** `gpt-5.5`, `o4-mini` 등 `/v1/models`에 있는 ID |
| `input` | string \| array | 텍스트 한 줄 또는 멀티모달 아이템 배열. 우리 CLI가 보내는 `[{type:"message",role:"user",content:[{type:"input_text",text:...}]}]` 형태와 호환 |
| `instructions` | string | 시스템 지시문 (공식 API에선 **옵셔널**) |
| `tools` | array | 함수/내장 도구 정의 |
| `tool_choice` | string \| object | `"auto"`, `"required"`, `"none"`, 또는 특정 도구 강제 |
| `parallel_tool_calls` | boolean | 도구 병렬 호출 허용 여부 |
| `stream` | boolean | true면 SSE로 응답 |
| `store` | boolean | 서버에 응답 저장 (기본 true). 저장한 응답은 `previous_response_id`로 이어쓸 수 있음 |
| `previous_response_id` | string | 이전 응답 ID — 멀티턴 체인 |
| `reasoning` | `{ effort, summary }` | reasoning 모델 한정 |
| `include` | array | 추가 필드: `reasoning.encrypted_content`, `message.input_image.image_url`, `file_search_call.results` 등 |
| `temperature` | number | 0~2 |
| `top_p` | number | 0~1 |
| `max_output_tokens` | number | 출력 토큰 상한 |
| `service_tier` | string | `auto` / `default` / `flex` / `priority` |
| `truncation` | string | `auto` / `disabled` |
| `metadata` | object | 임의 key-value (최대 16개) |
| `user` | string | 어뷰즈 추적용 end-user ID |
| `prompt_cache_key` | string | 프리픽스 캐시 키 |
| `text` | object | 출력 형식 강제 (예: JSON schema) |

### 예시 — 비스트리밍

```bash
curl https://api.openai.com/v1/responses \
  -H "Authorization: Bearer sk-..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.5",
    "input": "say hi in three words"
  }'
```

### 예시 — 멀티턴 + 도구

```jsonc
{
  "model": "gpt-5.5",
  "input": "서울 날씨 알려줘",
  "previous_response_id": "resp_abc123",
  "tools": [
    {
      "type": "function",
      "name": "get_weather",
      "description": "...",
      "parameters": { "type": "object", "properties": { "city": { "type": "string" } }, "required": ["city"] }
    }
  ],
  "tool_choice": "auto",
  "store": true
}
```

## 응답 — 비스트리밍

```jsonc
{
  "id": "resp_abc123",
  "object": "response",
  "created_at": 1700000000,
  "status": "completed",      // queued | in_progress | completed | incomplete | failed | cancelled
  "model": "gpt-5.5-2026-XX",
  "output": [
    {
      "type": "message",
      "id": "msg_xxx",
      "role": "assistant",
      "content": [
        { "type": "output_text", "text": "Hi there friend!", "annotations": [] }
      ]
    }
  ],
  "output_text": "Hi there friend!",   // 편의 필드 — output 배열의 모든 텍스트를 합친 것
  "usage": {
    "input_tokens": 12,
    "output_tokens": 4,
    "total_tokens": 16,
    "input_tokens_details": { "cached_tokens": 0 },
    "output_tokens_details": { "reasoning_tokens": 0 }
  },
  "metadata": {},
  "previous_response_id": null,
  "reasoning": { "effort": null, "summary": null },
  "error": null,
  "incomplete_details": null
}
```

도구 호출 응답이라면 `output` 배열에 `{ "type": "function_call", "name": "...", "arguments": "...", "call_id": "..." }` 아이템이 섞여 나온다.

## 응답 — 스트리밍 (SSE)

`stream: true`로 보내면 `text/event-stream`으로 이벤트가 흘러온다. 주요 타입:

| 이벤트 | 의미 |
|---|---|
| `response.created` | 응답 생성 시작, `response.id` 등 메타 |
| `response.in_progress` | 진행 상태 |
| `response.output_item.added` | 새 출력 아이템(메시지/도구호출 등) 추가됨 |
| `response.content_part.added` | 메시지 안에 새 콘텐츠 파트 시작 |
| `response.output_text.delta` | 텍스트 청크. `delta` 필드에 누적할 조각 |
| `response.output_text.done` | 한 텍스트 파트 종료 |
| `response.function_call_arguments.delta` | 도구 호출의 인자 JSON이 청크 단위로 |
| `response.function_call_arguments.done` | 도구 호출 인자 완성 |
| `response.completed` | 최종 완료. `response` 객체 전체 포함 (`usage` 등) |
| `response.failed` | 모델/시스템 실패 |
| `error` | 트랜스포트 또는 비복구 오류 |

각 이벤트는 `data: {...}\n\n` 형태 JSON. `[DONE]` 센티넬은 Chat Completions와 달리 일반적으로 사용하지 않는다 (단, 클라이언트는 받아도 무시할 수 있어야 함).

## 우리 CLI(ChatGPT 백엔드) vs 공식 OpenAI API

| 항목 | `vicoop-codex` (ChatGPT 백엔드) | 공식 OpenAI API |
|---|---|---|
| 엔드포인트 | `chatgpt.com/backend-api/codex/responses` | `api.openai.com/v1/responses` |
| 인증 | ChatGPT OAuth `Bearer <access_token>` | API 키 `Bearer sk-...` |
| 식별 헤더 | `ChatGPT-Account-ID`, `originator: codex_cli_rs` 필수 | 불필요. (선택적으로 `OpenAI-Organization`, `OpenAI-Project`) |
| 과금 주체 | 사용자 **ChatGPT 구독 한도** | **API 크레딧** |
| 가용 모델 | `/codex/models`로 조회 — 현재 `gpt-5.5`, `gpt-5.3-codex` 등 한정된 풀 | `/v1/models` — `gpt-5.5`, `gpt-5.4`, `o4-mini`, 등 공개된 전체 카탈로그 |
| `instructions` | **필수** (없으면 400) | 옵셔널 |
| `store` 기본 | 우리 CLI는 `false` 명시. 백엔드 기본 동작은 불분명 | **기본 true** — 저장된 응답은 `previous_response_id`로 이어붙임 |
| `previous_response_id` | 지원되는지 검증 안 됨 | 정식 지원 — 멀티턴의 핵심 |
| 스트림 SSE 이벤트 | `response.created`, `response.output_text.delta`, `response.completed`, `response.failed`, `error` 정도 관측 | 풀 세트: `response.*`, `response.output_item.*`, `response.content_part.*`, `response.function_call_arguments.*` 등 |
| 도구(tools) | 본문에 `tools: []` 비워서 사용 안 함 | 함수 도구, 내장 도구(web_search, file_search, code_interpreter 등) 정식 지원 |
| 안정성/문서화 | 비공개 내부 API. **언제든 깨질 수 있음** (모델 슬러그 변경, 필드 필수화 등이 실제로 발생함) | 공개 스펙, deprecation 정책 있음 |
| 권한 차단 신호 | 플랜 없거나 모델 부정확 시 400 + `"... not supported when using Codex with a ChatGPT account."` 같은 모호한 메시지 | 401(invalid key), 403(권한), 404(모델 없음) 등 일반 HTTP 코드와 명확한 `error` 객체 |
| 사용 시나리오 | 개인 ChatGPT 구독을 LLM 백엔드로 재활용 | 서비스에 내장해서 사용량 정산 가능한 정식 채널 |

### 어느 쪽을 써야 하나

- **개인/실험용으로 ChatGPT 구독을 활용**하려면 → 현재 CLI 방식 (단, 비공식이라 깨질 위험 인지)
- **프로덕션, 사용자별 과금, SLA 필요** → 무조건 공식 API (`sk-...`)
- **이 CLI를 공식 API 백엔드로도 동작하게 확장**하려면 `responses.ts`에서 URL과 헤더(`Authorization`만 남기고 다른 ChatGPT-전용 헤더 제거), 그리고 `instructions` 기본 주입 로직 정도만 분기하면 사실상 본문은 그대로 재사용 가능하다. 본문 스키마가 같은 Responses API 계열이라는 점이 큰 이점.

---

# 서버 모드 (`vicoop-codex serve`)

로컬에 HTTP 서버를 띄워 **공식 OpenAI Chat Completions API와 동일한 경로/스키마**(`POST /v1/chat/completions`)로 요청을 받고, 내부적으로는 ChatGPT Codex 백엔드를 호출한다. `OpenAI` SDK / LangChain / 각종 IDE 플러그인 등 기존 OpenAI 호환 클라이언트가 base URL만 바꿔서 그대로 동작.

구현: `src/commands/serve.ts`. 의존성 추가 없이 Node 내장 `http` 모듈만 사용.

## 실행

```bash
vicoop-codex serve                  # 127.0.0.1:8787에 바인드
vicoop-codex serve -p 9000          # 포트만 변경
vicoop-codex serve -H 0.0.0.0       # 외부 노출 (주의: 누구나 내 구독을 빨아 씀)
```

`Ctrl+C` 또는 `SIGTERM`으로 정상 종료.

## 노출 라우트

| 메서드 | 경로 | 비고 |
|---|---|---|
| POST | `/v1/chat/completions` | OpenAI Chat Completions 호환. 비스트리밍/스트리밍 모두 |
| 그 외 | * | 404 + OpenAI 형식 에러 |

본 CLI는 단일 라우트만 구현한다. `/v1/responses`, `/v1/embeddings`, `/v1/models` 등은 미지원(404).

> 왜 `/v1/responses`가 아니라 `/v1/chat/completions`인가? 호환 클라이언트 절대다수(OpenAI 구버전 SDK, LangChain, Continue.dev, ollama 호환 툴 등)가 Chat Completions를 1순위로 때리기 때문. Codex 백엔드는 Responses 스키마이지만 서버 안에서 양방향 번역해 Chat Completions 모양으로 노출한다.

## 인증 정책

- **들어오는 `Authorization` 헤더는 무시한다.** 클라이언트는 더미 값(`sk-anything`)을 보내도 되고, 아예 안 보내도 된다.
- 서버는 로컬 디스크의 ChatGPT OAuth 자격증명(`~/.vicoop-codex/auth.json`)을 사용해 업스트림을 호출한다.
- 따라서 **외부에 노출하면 누구나 이 머신의 ChatGPT 구독을 쓸 수 있다.** 기본 바인드를 `127.0.0.1`로 둔 이유.
- 외부 노출이 필요하면 자체적으로 리버스 프록시 + API 키 인증 레이어를 앞단에 두는 것을 권장.

## 요청 변환 (Chat Completions → Codex 백엔드)

요점만:

- `messages`의 system/developer → `instructions`(join), user/assistant → `input[]` 아이템(`input_text`/`output_text`)
- `tools[].function.{...}` → `tools[].{...}` (한 단계 평탄화)
- `tool_choice` 객체도 같은 식으로 평탄화
- `reasoning_effort` → `reasoning.effort`
- `store: false`, `include: []`, `stream: true` 고정
- 그 외 필드(`max_tokens`, `temperature`, `top_p`, `user`, `response_format` 등)는 백엔드가 안 받아서 **드롭**. 드롭된 필드는 stderr에 한 줄 로그.

> 필드별 상세 매핑/예시/드롭 사유는 [`chat-completions-translation.md`](./chat-completions-translation.md) 참고.

## 응답 변환 (Codex 백엔드 → Chat Completions)

### 비스트리밍 (`stream: false` 또는 누락)

업스트림 SSE를 전부 버퍼링한 뒤 Chat Completions JSON 한 덩어리로 반환.

1. `response.output_item.done` 이벤트들을 `output_index`로 인덱싱해 모음.
   - **주의**: Codex 백엔드의 `response.completed` 이벤트는 `output: []`로 비어 있다(스트림 어셈블 의도). 그래서 `output_item.done`을 별도로 수집해야 함.
2. 모인 `output` 아이템들에서:
   - `type: "message"` → 안의 `content[].text` 중 `output_text` 타입을 모두 이어붙여 `choices[0].message.content`로
   - `type: "function_call"` → `choices[0].message.tool_calls[]`로. `name`, `arguments`, `call_id` 매핑
3. `finish_reason`: tool_call 있으면 `"tool_calls"`, 아니면 `"stop"`
4. `usage` 키 이름 변환:
   - `input_tokens` → `prompt_tokens`
   - `output_tokens` → `completion_tokens`
   - `total_tokens` → `total_tokens`
5. `id`: `resp_xxx` → `chatcmpl-xxx` (prefix 교체)
6. `object: "chat.completion"`, `created: response.created_at`

결과 JSON 형태:

```jsonc
{
  "id": "chatcmpl-0d7d729199b46e14...",
  "object": "chat.completion",
  "created": 1779171751,
  "model": "gpt-5.4",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "ok" },
      "finish_reason": "stop"
    }
  ],
  "usage": { "prompt_tokens": 20, "completion_tokens": 5, "total_tokens": 25 }
}
```

도구 호출 응답이면 message에 `tool_calls` 배열이 추가되고 `content`는 `null`이 된다.

### 스트리밍 (`stream: true`)

업스트림 Responses SSE 이벤트를 Chat Completions chunk 포맷으로 변환해 전달:

| 업스트림 이벤트 | 우리가 보내는 chunk |
|---|---|
| `response.created` | (chatId, model 저장만, 출력 X) |
| 첫 `response.output_text.delta` 직전 | `data: {"choices":[{"delta":{"role":"assistant","content":""},"finish_reason":null}], ...}` (role 청크) |
| `response.output_text.delta` | `data: {"choices":[{"delta":{"content":"<delta>"},"finish_reason":null}], ...}` |
| `response.output_item.done` (function_call) | finish_reason을 `"tool_calls"`로 기록 |
| `response.completed` | `data: {"choices":[{"delta":{},"finish_reason":"stop|tool_calls"}], "usage":{...}}` + `data: [DONE]` |
| `response.failed` / `error` | 에러 청크 + `[DONE]`으로 종료 |

각 chunk에는 `id`, `object: "chat.completion.chunk"`, `created`, `model` 동봉. OpenAI 공식 SDK가 그대로 파싱 가능.

## 에러 응답

업스트림 에러는 OpenAI 형식으로 정규화:

```jsonc
{
  "error": {
    "message": "<업스트림 detail 또는 우리 메시지>",
    "type": "api_error" | "invalid_request_error" | "authentication_error",
    "code": null
  }
}
```

| HTTP | 발생 조건 |
|---|---|
| 400 | JSON 파싱 실패, `messages` 누락/빈 배열 |
| 401 | 로컬에 OAuth 토큰 없음 → `vicoop-codex login` 필요 |
| 404 | 허용된 라우트(`POST /v1/chat/completions`) 외 |
| 4xx/5xx 패스스루 | 업스트림이 4xx/5xx로 응답한 경우 status와 `detail`을 그대로 전달 |
| 502 | 업스트림 스트림이 `response.failed`/`error`로 끝났거나 `response.completed`가 안 옴 |

## 사용 예

### curl

```bash
# 비스트리밍
curl -sS http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model":"gpt-5.3-codex",
    "messages":[
      {"role":"system","content":"Reply in Korean only."},
      {"role":"user","content":"안녕"}
    ]
  }' | jq '.choices[0].message.content'

# 스트리밍
curl -sS -N http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model":"gpt-5.5",
    "messages":[{"role":"user","content":"say hi"}],
    "stream":true
  }'
```

### OpenAI 공식 SDK (Python)

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8787/v1",
    api_key="sk-anything",   # 우리 서버는 무시함
)

# 비스트리밍
r = client.chat.completions.create(
    model="gpt-5.3-codex",
    messages=[
        {"role": "system", "content": "You are concise."},
        {"role": "user", "content": "say hi"},
    ],
)
print(r.choices[0].message.content)

# 스트리밍
stream = client.chat.completions.create(
    model="gpt-5.5",
    messages=[{"role": "user", "content": "포에 짧게 하나"}],
    stream=True,
)
for chunk in stream:
    delta = chunk.choices[0].delta
    if delta.content:
        print(delta.content, end="", flush=True)
```

### OpenAI 공식 SDK (Node)

```ts
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://127.0.0.1:8787/v1",
  apiKey: "sk-anything",
});

const r = await client.chat.completions.create({
  model: "gpt-5.3-codex",
  messages: [{ role: "user", content: "say hi" }],
});
console.log(r.choices[0].message.content);
```

## 알려진 한계

- `role: "tool"`/`role: "function"` 메시지(도구 결과를 모델에 다시 입력)는 현재 변환 X. 도구 사용 다중 라운드는 시도 시 깨질 수 있음.
- `response_format` (JSON 모드/structured outputs), `seed`, `logprobs`, `n`, `frequency_penalty`, `presence_penalty` 미지원. 필요 시 매핑 추가 필요.
- 멀티모달 입력 중 텍스트만 추출. 이미지/오디오 파트는 무시됨.
- 응답 헤더의 `x-codex-*` 사용량 정보는 현재 클라이언트로 전달되지 않는다.
- 비스트리밍 모드에서 우리는 전체 응답을 메모리에 버퍼링한다. 매우 긴 응답에는 부적합.

## 참고 링크

- [Create a model response | OpenAI API Reference](https://platform.openai.com/docs/api-reference/responses/create)
- [Migrate to the Responses API | OpenAI API](https://platform.openai.com/docs/guides/migrate-to-responses)
- [Using tools | OpenAI API](https://platform.openai.com/docs/guides/tools)
- [Why we built the Responses API | OpenAI Developers](https://developers.openai.com/blog/responses-api)
- [openai/codex (codex_cli_rs source)](https://github.com/openai/codex)
