# `vicoop-codex call` 가이드

`call` 서브커맨드는 OpenAI **Chat Completions** 형식의 요청 본문(JSON)을 받아, `serve`와 동일한 변환 파이프라인을 거쳐 ChatGPT Codex 백엔드를 호출하고, **OpenAI Chat Completions 응답 JSON**을 stdout으로 출력합니다. HTTP 서버를 띄우지 않고 한 번 호출하고 끝나는 형태.

## 어디에 쓰는가

| 시나리오 | 추천 |
|---|---|
| 셸 스크립트/Makefile/cron에서 한 번 LLM 호출하고 결과 받기 | `call` |
| OpenAI SDK가 base_url을 통해 멀티턴/스트리밍으로 쓰는 경우 | `serve` |
| 그냥 텍스트 한 줄 묻고 답 받기 | `prompt` |

`call`은 OpenAI 표준 본문/응답 스키마를 **그대로 보존**하므로, 같은 JSON을 `curl -X POST /v1/chat/completions`에도 보낼 수 있고 응답도 거의 동일합니다 (스트리밍 옵션만 다름 — `call`은 항상 비스트리밍).

## 호출 방법

본문은 (1) 첫 번째 인자 또는 (2) stdin으로 받습니다.

```bash
# 인자로
vicoop-codex call '{"messages":[{"role":"user","content":"hi"}]}'

# stdin으로 (한 줄)
echo '{"messages":[{"role":"user","content":"hi"}]}' | vicoop-codex call

# stdin으로 (파일)
cat body.json | vicoop-codex call

# 인자로 + 여러 줄 (heredoc)
vicoop-codex call "$(cat <<'EOF'
{
  "model": "gpt-5.3-codex",
  "messages": [
    { "role": "user", "content": "hello" }
  ]
}
EOF
)"
```

## 입력 JSON — 전체 필드 정의

OpenAI Chat Completions API의 표준 본문 스키마를 따릅니다. 필드는 세 부류로 나뉩니다.

### A. 백엔드로 전달되는 필드 (= 효과 있음)

| 필드 | 타입 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `model` | string | optional | `gpt-5.3-codex` | 사용할 모델 슬러그. 백엔드 허용 목록의 값만 가능 |
| `messages` | array | **required** | — | 대화 메시지 배열 (아래 상세) |
| `tools` | array | optional | `[]` | 모델이 호출할 수 있는 함수 정의 (아래 상세) |
| `tool_choice` | `"auto" \| "required" \| "none" \| { type: "function", function: { name } }` | optional | `"auto"` | 도구 선택 전략 |
| `parallel_tool_calls` | boolean | optional | `false` | 도구 병렬 호출 허용 여부 |
| `reasoning_effort` | `"low" \| "medium" \| "high"` | optional | (백엔드 기본값) | reasoning 모델의 추론 깊이 |

### B. 자동으로 고정되는 필드 (= 본문에 써도 무시됨)

| 필드 | 강제 값 | 이유 |
|---|---|---|
| `store` | `false` | 멀티턴은 messages 배열로만 (서버 측 이력 X) |
| `stream` | (업스트림엔 `true`) | call은 항상 비스트리밍 결과 반환. 본문에 `stream: true`로 줘도 SDK가 정상 JSON 받음 |
| `include` | `[]` | reasoning encrypted_content 등 부가 페이로드 필요 없음 |

### C. 드롭되는 필드 (= 본문에 써도 무시 + stderr 경고)

ChatGPT Codex 백엔드가 받지 않는 필드. 본문에 들어 있어도 `call`이 알아서 빼내고, stderr에 `note: dropped unsupported fields: ...` 한 줄로 알림.

| 필드 | 이유 |
|---|---|
| `max_tokens`, `max_completion_tokens` | 백엔드가 `Unsupported parameter: max_output_tokens`로 거절 |
| `temperature`, `top_p` | 공식 codex CLI도 안 보냄. 모델별 기본값 사용 |
| `frequency_penalty`, `presence_penalty` | 동일 |
| `seed`, `stop` | 동일 |
| `n` | 항상 단일 응답 (n=1 강제) |
| `logprobs`, `top_logprobs`, `logit_bias` | 백엔드 미지원 |
| `response_format` | `text.format`으로 옮기는 변환 미구현 |
| `metadata`, `user`, `service_tier` | 비공식 백엔드엔 의미 없음 |

> 화이트리스트 정의: `src/translate/chat-completions.ts`의 `UPSTREAM_ACCEPTED_FIELDS` 상수. 필드를 추가/검증해야 하면 여기를 본다.

## `messages` 배열 상세

`messages`는 비어 있지 않은 배열이어야 합니다. 각 원소는 `{ role, content, ... }` 객체.

### 역할(role)별 동작

| `role` | 처리 | 결과 |
|---|---|---|
| `"system"` | content 텍스트 추출 후 join | 업스트림 `instructions` 필드에 합쳐짐 |
| `"developer"` | system과 동일 (별칭) | 업스트림 `instructions` |
| `"user"` | content 텍스트 추출 | `input[]`에 `{type:"message", role:"user", content:[{type:"input_text", text}]}` |
| `"assistant"` | content (텍스트) + `tool_calls` | 텍스트는 `{type:"message", role:"assistant", content:[{type:"output_text", text}]}`, tool_calls는 각 호출이 `{type:"function_call", call_id, name, arguments}` 아이템으로 |
| `"tool"` 또는 `"function"` | content + `tool_call_id` | `{type:"function_call_output", call_id, output}` |

**중요:**
- `system`이 하나도 없거나 모두 비어있으면 자동으로 `"You are a helpful assistant."`가 들어갑니다 (백엔드가 `instructions` 필수).
- `assistant` 메시지의 `content`는 `null`이어도 됨 (도구 호출만 한 경우).
- `tool` 역할 메시지는 반드시 `tool_call_id`로 어떤 `assistant.tool_calls[].id`에 대한 응답인지 매칭돼야 함.

### content 형식

문자열 또는 멀티모달 파트 배열.

```jsonc
// 형식 1: 문자열
{ "role": "user", "content": "hello" }

// 형식 2: 멀티모달 배열 (텍스트 파트만 추출됨, 이미지/오디오는 무시)
{
  "role": "user",
  "content": [
    { "type": "text", "text": "이 이미지를 설명해줘" },
    { "type": "image_url", "image_url": { "url": "..." } }
  ]
}
```

### 메시지별 JSON 예시

#### system / developer

```jsonc
{ "role": "system", "content": "You are a concise assistant. Reply in Korean." }
{ "role": "developer", "content": "Internal: prefer Celsius units." }
```

#### user

```jsonc
{ "role": "user", "content": "Seoul 날씨 알려줘" }
```

#### assistant (텍스트 응답 — 이력 재구성용)

```jsonc
{ "role": "assistant", "content": "안녕하세요." }
```

#### assistant (도구 호출)

```jsonc
{
  "role": "assistant",
  "content": null,
  "tool_calls": [
    {
      "id": "call_abc123",
      "type": "function",
      "function": {
        "name": "get_weather",
        "arguments": "{\"city\":\"Seoul\",\"unit\":\"celsius\"}"
      }
    }
  ]
}
```

#### tool (도구 결과)

```jsonc
{
  "role": "tool",
  "tool_call_id": "call_abc123",
  "content": "{\"temp_c\":13,\"condition\":\"cloudy\"}"
}
```

## `tools` 배열 상세

OpenAI Chat Completions의 도구 정의는 `{type, function:{...}}` 모양인데, `call`이 내부적으로 `{type, ...}`로 평탄화해서 백엔드에 보냅니다.

```jsonc
{
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get current weather for a city.",
        "parameters": {
          "type": "object",
          "properties": {
            "city": { "type": "string", "description": "City name" },
            "unit": { "type": "string", "enum": ["celsius", "fahrenheit"] }
          },
          "required": ["city"]
        }
      }
    }
  ]
}
```

| 필드 | 필수 | 설명 |
|---|---|---|
| `type` | yes | 현재는 `"function"`만 지원 |
| `function.name` | yes | JS 식별자 형식 (글자/숫자/`_`) |
| `function.description` | no | 모델이 도구 선택 시 참고 |
| `function.parameters` | no | JSON Schema 형식의 인자 정의 |

## `tool_choice` 상세

| 값 | 의미 |
|---|---|
| `"auto"` | 모델이 도구 사용 여부 결정 (기본값) |
| `"required"` | 반드시 도구를 호출해야 함 |
| `"none"` | 도구 사용 금지 |
| `{ type: "function", function: { name: "..." } }` | 특정 함수 강제 호출 (call이 `{type:"function", name}`로 평탄화) |

## 출력 JSON

표준 OpenAI Chat Completions 비스트리밍 응답 형태:

```jsonc
{
  "id": "chatcmpl-0ac936d09234272e016a0c17c379708191b628ae07871deaf4",
  "object": "chat.completion",
  "created": 1779177411,
  "model": "gpt-5.4",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "ok"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 17,
    "completion_tokens": 5,
    "total_tokens": 22
  }
}
```

### 필드별 의미

| 필드 | 설명 |
|---|---|
| `id` | `chatcmpl-<백엔드 응답 id에서 resp_ 제거>` 형식 |
| `object` | 항상 `"chat.completion"` |
| `created` | 백엔드의 `response.created_at` (Unix epoch 초). 없으면 현재 시각 |
| `model` | **백엔드가 실제 라우팅한 모델 슬러그.** 요청 `model`과 다를 수 있음 (예: `gpt-5.3-codex` 요청 → `gpt-5.4` 반환). 신뢰해야 할 모델명은 응답의 이 필드 |
| `choices` | 항상 길이 1 배열. n>1 미지원 |
| `choices[0].index` | 항상 `0` |
| `choices[0].message.role` | 항상 `"assistant"` |
| `choices[0].message.content` | 텍스트 응답. 도구만 호출하고 본문 텍스트가 없으면 `null` |
| `choices[0].message.tool_calls` | 모델이 도구 호출을 요청한 경우 배열로 (아래 참고) |
| `choices[0].finish_reason` | `"stop"` (정상) 또는 `"tool_calls"` (도구 호출로 끝남) |
| `usage.prompt_tokens` | 입력 토큰 수 |
| `usage.completion_tokens` | 출력 토큰 수 |
| `usage.total_tokens` | 합계 |

### 도구 호출 응답일 때 `message.tool_calls`

```jsonc
{
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": null,
        "tool_calls": [
          {
            "id": "call_4hvhXvdkwGRJqL2PbjmVVzMH",
            "type": "function",
            "function": {
              "name": "list_files",
              "arguments": "{\"path\":\".\"}"
            }
          }
        ]
      },
      "finish_reason": "tool_calls"
    }
  ]
}
```

`arguments`는 항상 JSON 문자열(JSON 객체 아님). 도구 실행 측에서 `JSON.parse(arguments)` 필요.

## 시나리오별 예시

### 1) 가장 간단한 호출

```bash
vicoop-codex call '{"messages":[{"role":"user","content":"3+5=?"}]}'
```

`model`이 빠지면 `gpt-5.3-codex`, `instructions`가 없으면 `"You are a helpful assistant."` 자동 주입.

### 2) 시스템 지시문 + 사용자 메시지

```bash
vicoop-codex call '{
  "model": "gpt-5.5",
  "messages": [
    {"role":"system","content":"Reply in Korean only. One sentence."},
    {"role":"user","content":"What is the capital of France?"}
  ]
}'
```

### 3) Reasoning 모델 + 깊은 추론

```bash
vicoop-codex call '{
  "model": "gpt-5.5",
  "messages": [{"role":"user","content":"Prove that sqrt(2) is irrational."}],
  "reasoning_effort": "high"
}'
```

### 4) 도구 호출 라운드 (1턴: 도구 호출 요청 받기)

```bash
vicoop-codex call "$(cat <<'EOF'
{
  "model": "gpt-5.3-codex",
  "messages": [
    {"role":"system","content":"Use the get_weather tool when asked about weather."},
    {"role":"user","content":"서울 날씨 알려줘"}
  ],
  "tools": [{
    "type": "function",
    "function": {
      "name": "get_weather",
      "description": "Get current weather for a city.",
      "parameters": {
        "type": "object",
        "properties": {
          "city": { "type": "string" },
          "unit": { "type": "string", "enum": ["celsius","fahrenheit"] }
        },
        "required": ["city"]
      }
    }
  }],
  "tool_choice": "auto"
}
EOF
)"
```

응답에서 `choices[0].message.tool_calls[0]`을 받아 도구를 실행한 뒤, 다음 턴으로 진행:

### 5) 도구 호출 라운드 (2턴: 결과 돌려주기)

```bash
vicoop-codex call "$(cat <<'EOF'
{
  "model": "gpt-5.3-codex",
  "messages": [
    {"role":"system","content":"Use the get_weather tool when asked about weather."},
    {"role":"user","content":"서울 날씨 알려줘"},
    {"role":"assistant","content":null,"tool_calls":[{
      "id":"call_abc","type":"function",
      "function":{"name":"get_weather","arguments":"{\"city\":\"Seoul\",\"unit\":\"celsius\"}"}
    }]},
    {"role":"tool","tool_call_id":"call_abc","content":"{\"temp_c\":13,\"condition\":\"cloudy\"}"}
  ],
  "tools": [{"type":"function","function":{"name":"get_weather","description":"...","parameters":{}}}]
}
EOF
)"
```

### 6) 모든 필드를 다 쓴 풀 예시

전달되는 것/드롭되는 것이 한눈에 보이는 예시. stderr에 `note: dropped unsupported fields: max_tokens, temperature, ...` 가 같이 찍힙니다.

```bash
vicoop-codex call "$(cat <<'EOF'
{
  "model": "gpt-5.5",
  "messages": [
    { "role": "system",    "content": "You are a concise assistant." },
    { "role": "developer", "content": "Internal note: prefer Celsius." },
    { "role": "user",      "content": "Seoul 날씨?" },
    { "role": "assistant", "content": null, "tool_calls": [
      { "id": "call_1", "type": "function",
        "function": { "name": "get_weather",
                      "arguments": "{\"city\":\"Seoul\"}" } }
    ]},
    { "role": "tool", "tool_call_id": "call_1",
      "content": "{\"temp_c\":13,\"condition\":\"cloudy\"}" },
    { "role": "user", "content": [
      { "type": "text", "text": "이제 요약해줘." }
    ]}
  ],
  "tools": [{
    "type": "function",
    "function": {
      "name": "get_weather",
      "description": "Get weather.",
      "parameters": {
        "type": "object",
        "properties": {
          "city": { "type": "string" },
          "unit": { "type": "string", "enum": ["celsius","fahrenheit"] }
        },
        "required": ["city"]
      }
    }
  }],
  "tool_choice": { "type": "function", "function": { "name": "get_weather" } },
  "parallel_tool_calls": false,
  "reasoning_effort": "high",
  "stream": false,

  "max_tokens": 200,
  "max_completion_tokens": 200,
  "temperature": 0.7,
  "top_p": 0.9,
  "n": 1,
  "seed": 42,
  "stop": ["\n\n"],
  "frequency_penalty": 0,
  "presence_penalty": 0,
  "logprobs": false,
  "top_logprobs": 0,
  "logit_bias": {},
  "response_format": { "type": "text" },
  "service_tier": "auto",
  "user": "user-abc-123",
  "metadata": { "session": "demo" }
}
EOF
)"
```

## 종료 코드(exit code)

| 코드 | 의미 |
|---|---|
| `0` | 성공 |
| `2` | 입력 검증 실패 (빈 본문 / 잘못된 JSON / `messages` 누락) |
| `3` | 로그인 안 됨 — `vicoop-codex login` 필요 |
| `4` | 업스트림(백엔드) 에러 (모델 거절, 401/403/429/5xx, 스트림 실패) |
| `5` | 네트워크/연결 실패 (DNS, 방화벽 등) |

각 코드에 해당하는 에러 메시지는 사용자 가이드 톤으로 stderr에 함께 출력됩니다 — 예:

- `Error: Not signed in. ... $ vicoop-codex login`
- `Error: Invalid JSON body: ... Example of a valid request body: { ... }`
- `Error: ChatGPT Codex backend rejected the request (HTTP 400). ...`
- `Error: 'messages' is required and must be a non-empty array. ...`

## 알려진 제약

- **n > 1 미지원** — Responses API 자체가 단일 응답.
- **`role: "tool"` 메시지의 `content`는 텍스트로만** — 멀티모달 도구 결과 미지원.
- **이미지/오디오 입력** — `content` 배열에 `image_url`/`input_audio` 파트가 있어도 텍스트 파트만 추출하고 나머지는 무시.
- **백엔드 모델 라우팅** — 요청 `model`과 응답 `model`이 다를 수 있음 (백엔드가 알아서 결정). 응답의 `model`을 신뢰할 것.
- **스트리밍 미지원** — 본문에 `"stream": true`로 줘도 `call`은 항상 단일 JSON 응답. 스트리밍이 필요하면 `serve` 명령으로 HTTP 서버를 띄우고 `/v1/chat/completions`를 호출하세요.

## 코드 참조

| 무엇 | 위치 |
|---|---|
| 입력 본문 변환 | `src/translate/chat-completions.ts` → `chatCompletionsToUpstream` |
| 백엔드 호출 + SSE 버퍼링 | `src/translate/chat-completions.ts` → `collectChatCompletion` |
| 응답 어셈블 | `src/translate/chat-completions.ts` → `buildChatCompletion` |
| 허용 필드 화이트리스트 | `src/translate/chat-completions.ts` → `UPSTREAM_ACCEPTED_FIELDS` |
| call 진입점 | `src/commands/call.ts` → `callCommand` |
| 에러 메시지 포맷터 | `src/cli/help-errors.ts` |

요청 → 백엔드 본문 변환 규칙의 더 자세한 매핑표는 [`chat-completions-translation.md`](./chat-completions-translation.md), 백엔드 자체 명세는 [`chatgpt-codex-backend.md`](./chatgpt-codex-backend.md) 참고.
