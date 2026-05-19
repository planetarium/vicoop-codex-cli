# Chat Completions → Codex Backend 요청 변환

`vicoop-codex serve`(서버 모드)에 들어온 **OpenAI Chat Completions** 요청을 **ChatGPT Codex 백엔드**(`/backend-api/codex/responses`)로 포워딩할 때 본문이 어떻게 바뀌는지에 대한 매핑 명세.

코드 위치: `src/commands/serve.ts` → `chatCompletionsToUpstream(body)`

## TL;DR 매핑표

| Chat Completions | 변환 | Codex Backend |
|---|---|---|
| `model` | passthrough | `model` |
| `messages[]` role: `system` / `developer` | join (`\n\n`) | `instructions` (string) |
| `messages[]` role: `user` | wrap | `input[]` 아이템 (`type:message`, `content:[{type:input_text}]`) |
| `messages[]` role: `assistant` (text) | wrap | `input[]` 아이템 (`type:message`, `content:[{type:output_text}]`) |
| `messages[]` role: `assistant` (`tool_calls`) | per-call | `input[]` 아이템 (`type:function_call`, `call_id`, `name`, `arguments`) |
| `messages[]` role: `tool` / `function` | wrap | `input[]` 아이템 (`type:function_call_output`, `call_id`, `output`) |
| `tools[].function.*` | flatten | `tools[]` (function 객체 평탄화) |
| `tool_choice` (객체) | flatten | `tool_choice` (객체 평탄화) |
| `tool_choice` (문자열) | passthrough | `tool_choice` |
| `parallel_tool_calls` | passthrough | `parallel_tool_calls` |
| `reasoning_effort` | wrap | `reasoning: { effort }` |
| `stream` | 클라이언트용으로만 사용 | (업스트림은 항상 `stream: true`) |
| — | 고정 | `store: false`, `include: []` |
| 그 외 모든 필드 | **drop** | — |

## 변환 흐름

```
Client (OpenAI SDK / curl / IDE 플러그인)
        │
        │ POST /v1/chat/completions
        │ { model, messages, tools, max_tokens, ... }
        ▼
  ┌──────────────────────────────────────┐
  │  vicoop-codex serve                  │
  │                                      │
  │  chatCompletionsToUpstream()         │
  │   1. messages 분해                   │
  │      - system/developer→instructions │
  │      - user/assistant → input        │
  │   2. tools[] flatten                 │
  │   3. tool_choice flatten             │
  │   4. reasoning_effort wrap           │
  │   5. UPSTREAM_ACCEPTED_FIELDS 필터   │
  │   6. drop된 필드 stderr 로깅         │
  └──────────────────────────────────────┘
        │
        │ POST chatgpt.com/backend-api/codex/responses
        │ { model, instructions, input, tools, ... }
        ▼
  ChatGPT Codex Backend (SSE 응답)
```

## 필드별 변환 상세

### `model`

그대로 전달. 누락 시 기본값 `gpt-5.3-codex`. 백엔드의 `/codex/models` 응답에 있는 슬러그만 허용 (`gpt-5.5`, `gpt-5.3-codex` 등). 모르는 슬러그는 백엔드가 400으로 거절한다.

### `messages` → `instructions` + `input`

OpenAI는 모든 컨텍스트를 하나의 `messages` 배열에 담지만, Codex는 시스템 지시문(`instructions`)과 사용자 대화(`input`)를 분리해서 받는다.

#### system / developer → `instructions` (string)

여러 개면 본문 텍스트를 `\n\n`으로 join. 하나도 없으면 기본값 `"You are a helpful assistant."`로 채움 (Codex는 빈 `instructions`를 거절: `400 "Instructions are required"`).

```jsonc
// IN
{ "messages": [
  { "role": "system", "content": "Be terse." },
  { "role": "system", "content": "Reply in Korean." },
  { "role": "user", "content": "..." }
]}

// OUT
{ "instructions": "Be terse.\n\nReply in Korean.", ... }
```

#### user / assistant → `input` 아이템

각 메시지를 `{type:"message", role, content:[...]}` 모양으로 wrap. content 타입이 role에 따라 다르다:

| role | content type |
|---|---|
| `user` | `input_text` |
| `assistant` | `output_text` |

`content`가 문자열이면 그대로, 멀티모달 배열(`[{type:"text", text}, {type:"image_url", ...}]`)이면 **`type:"text"` 파트만** 추출해서 합친다. 이미지/오디오 파트는 현재 무시.

```jsonc
// IN
{ "messages": [
  { "role": "user", "content": "안녕" },
  { "role": "assistant", "content": "Hi" },
  { "role": "user", "content": "한국말로 해줘" }
]}

// OUT
{ "input": [
  { "type": "message", "role": "user",      "content": [{ "type": "input_text",  "text": "안녕" }] },
  { "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": "Hi" }] },
  { "type": "message", "role": "user",      "content": [{ "type": "input_text",  "text": "한국말로 해줘" }] }
]}
```

#### assistant의 `tool_calls` → `function_call` 아이템

Chat Completions에서 모델이 도구 호출을 요청하면 `assistant` 메시지가 `content: null` + `tool_calls: [...]` 모양으로 인코딩된다. 각 호출을 Responses의 `function_call` 입력 아이템으로 풀어서 `input`에 추가:

```jsonc
// IN
{ "role": "assistant", "content": null, "tool_calls": [
  { "id": "call_abc", "type": "function",
    "function": { "name": "list_files", "arguments": "{\"path\":\".\"}" } }
]}

// OUT (input 배열에 push)
{ "type": "function_call", "call_id": "call_abc",
  "name": "list_files", "arguments": "{\"path\":\".\"}" }
```

`assistant` 메시지에 텍스트 `content`와 `tool_calls`가 둘 다 있으면 둘 다 emit한다 (텍스트는 `message`, 호출들은 `function_call`).

#### `role: "tool"` / `role: "function"` → `function_call_output` 아이템

도구 실행 결과를 모델에 되돌려주는 메시지. `tool_call_id`로 어느 호출에 대한 결과인지 매칭된다.

```jsonc
// IN
{ "role": "tool", "tool_call_id": "call_abc",
  "content": "README.md\npackage.json\n..." }

// OUT (input 배열에 push)
{ "type": "function_call_output", "call_id": "call_abc",
  "output": "README.md\npackage.json\n..." }
```

이 변환이 빠지면 모델은 도구 결과를 못 받은 상태가 유지돼 같은 도구를 계속 호출 → 에이전트 측에서 "exceeded N iterations"로 강제 종료된다.

### `tools` 평탄화

Chat Completions 스키마와 Responses 스키마의 함수 정의 모양이 한 칸 다르다.

```jsonc
// Chat Completions (IN)
{ "tools": [
  {
    "type": "function",
    "function": {
      "name": "get_weather",
      "description": "Returns weather for a city.",
      "parameters": { "type": "object", "properties": { "city": { "type": "string" } } }
    }
  }
]}

// Codex Responses (OUT)
{ "tools": [
  {
    "type": "function",
    "name": "get_weather",
    "description": "Returns weather for a city.",
    "parameters": { "type": "object", "properties": { "city": { "type": "string" } } }
  }
]}
```

내부 `function` 객체의 키들이 한 단계 위로 올라온다. `type: "function"`이 아닌 다른 타입(예: 내장 도구)이면 그대로 통과.

### `tool_choice` 평탄화

문자열 형태(`"auto"`, `"required"`, `"none"`)는 그대로. 누락 시 `"auto"` 기본값.

객체로 특정 함수를 강제할 때만 평탄화:

```jsonc
// IN
{ "tool_choice": { "type": "function", "function": { "name": "get_weather" } } }

// OUT
{ "tool_choice": { "type": "function", "name": "get_weather" } }
```

### `reasoning_effort` → `reasoning.effort`

```jsonc
// IN
{ "reasoning_effort": "high" }

// OUT
{ "reasoning": { "effort": "high" } }
```

값은 `"low" | "medium" | "high"` (백엔드가 `"xhigh"`도 지원하긴 함). `reasoning_effort` 미지정 시 `reasoning` 필드 자체를 안 보냄 → 백엔드가 모델 기본값 사용.

### 항상 고정되는 필드

| Codex 필드 | 값 | 이유 |
|---|---|---|
| `store` | `false` | 서버 측 이력 저장 안 씀. 멀티턴은 클라이언트가 `messages`로 다시 보내는 방식 |
| `include` | `[]` | reasoning encrypted 등 부가 페이로드 없이 받음 |
| `stream` | `true` | 업스트림 호출은 늘 SSE. 클라이언트가 비스트리밍을 원하면 서버가 버퍼링해서 단일 JSON으로 응답 |

## 드롭되는 필드

업스트림 화이트리스트 `UPSTREAM_ACCEPTED_FIELDS`에 없는 필드는 전부 조용히 드롭. 어떤 게 드롭됐는지는 stderr에 한 줄 로그.

```
[2026-05-19T07:00:00.000Z] dropped unsupported fields: temperature, max_tokens
```

| Chat Completions 필드 | 드롭 사유 |
|---|---|
| `max_tokens`, `max_completion_tokens` | 백엔드가 `Unsupported parameter: max_output_tokens`로 거절 (실측) |
| `temperature` | 공식 `codex_cli_rs`도 안 보냄. 백엔드가 모델별 기본값 사용 |
| `top_p` | 동일 |
| `frequency_penalty`, `presence_penalty` | 동일 |
| `seed` | 동일 |
| `stop` | 동일. 출력 종료는 모델 결정 |
| `n` | Responses API는 항상 단일 응답. `n > 1` 미지원 |
| `logprobs`, `top_logprobs`, `logit_bias` | 백엔드 미지원 |
| `response_format` | `text.format`으로 옮기는 변환 미구현 (TODO) |
| `metadata` | 비공식 백엔드엔 별 의미 없음 |
| `user` | 공식 `codex_cli_rs`도 안 보냄 |
| `service_tier` | 백엔드가 자체 결정 (응답엔 들어옴, 요청은 무시) |
| `audio`, `modalities` | 오디오 입력 미지원 |
| `web_search_options`, `prediction`, `parallel_tool_calls 외 기타` | 미지원/미구현 |

화이트리스트 정의:

```typescript
// src/commands/serve.ts
const UPSTREAM_ACCEPTED_FIELDS = new Set([
  "model",
  "instructions",
  "input",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "reasoning",
  "store",
  "stream",
  "include",
]);
```

이 셋은 (1) 공식 `codex_cli_rs` 본문 빌더가 보내는 필드 + (2) 우리가 실제로 호출해 통과 확인한 필드의 교집합이다. 추가로 검증된 필드가 생기면 이 집합에 이름만 더 넣으면 된다.

## 전체 변환 예시

### 입력 (클라이언트 → /v1/chat/completions)

```jsonc
{
  "model": "gpt-5.3-codex",
  "messages": [
    { "role": "system", "content": "Helpful Assistant" },
    { "role": "user",   "content": "현재 디렉토리에 무슨 파일있니" }
  ],
  "max_tokens": 8192,
  "temperature": 0.7,
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "list_files",
        "description": "List files in a directory",
        "parameters": { "type": "object", "properties": { "path": { "type": "string" } } }
      }
    }
  ],
  "stream": false
}
```

### 출력 (서버 → ChatGPT Codex 백엔드)

```jsonc
{
  "model": "gpt-5.3-codex",
  "instructions": "Helpful Assistant",
  "input": [
    {
      "type": "message",
      "role": "user",
      "content": [{ "type": "input_text", "text": "현재 디렉토리에 무슨 파일있니" }]
    }
  ],
  "tools": [
    {
      "type": "function",
      "name": "list_files",
      "description": "List files in a directory",
      "parameters": { "type": "object", "properties": { "path": { "type": "string" } } }
    }
  ],
  "tool_choice": "auto",
  "parallel_tool_calls": false,
  "store": false,
  "stream": true,
  "include": []
}
```

### stderr 로그

```
[2026-05-19T07:00:00.000Z] POST /v1/chat/completions
{ ...위 입력 JSON 그대로... }
[2026-05-19T07:00:00.001Z] dropped unsupported fields: max_tokens, temperature
```

## 검증 체크리스트

기존 클라이언트가 변환 후 동작이 의도와 같은지 확인할 때 보는 포인트:

- [ ] system 지시문이 살아 있나? → 서버 stderr 본문 로그의 `instructions` 확인
- [ ] 도구가 평탄화돼 전달됐나? → 응답에 도구 호출이 나오는지, 또는 백엔드 400 에러 메시지 확인
- [ ] 드롭된 필드가 클라이언트 의도에 치명적이지 않은지? → stderr "dropped unsupported fields" 로그 확인
- [ ] `max_tokens` 같은 길이 제어가 필요한 경우 → 백엔드가 자체적으로 정하므로 클라이언트 측에서 추가 자르기 필요

## 코드 참조

- 변환: `src/commands/serve.ts:chatCompletionsToUpstream`
- 허용 필드: `src/commands/serve.ts:UPSTREAM_ACCEPTED_FIELDS`
- 호출: `src/commands/serve.ts:handleChatCompletions`
- 업스트림 POST: `src/client/responses.ts:postUpstream`
