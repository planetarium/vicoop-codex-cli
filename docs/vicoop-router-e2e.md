# vicoop-router e2e 가이드

`apps/web-vicoop-test` (Next.js) → `a2x-internal-router` (fly.dev) → `vicoop-bridge` (fly.dev WS) → 로컬 `vicoop-client` daemon → `vicoop-codex` CLI → ChatGPT 경로로 이미지 생성 e2e를 돌리는 절차를 처음부터 끝까지 정리한 문서. 새 세션에서 이 문서만 보면 서버 기동 → 호출 → 모니터링 → 디버깅까지 한 번에 가능해야 함.

## 프로젝트 구성
apps/web-vicoop-test는 a2x-comfyui-gen 모노레포 프로젝트에 포함되어있으며, apps/mcp-server도 함께 포함되어있다.
vicoop-client는 vicoop-bridge 모노레포 프로젝트에 포함된 packages/client 이다.

## 1. 아키텍처

두 갈래가 `apps/web-vicoop-test`에서 갈라진다.

**LLM path** (모델 호출): 

```
curl POST localhost:3000/api/a2a
  └─> apps/web-vicoop-test (Next.js, :3000)
       └─> @a2x/sdk LlmAgent
            └─> OpenAI SDK (baseURL=a2x-internal-router.fly.dev/api/v1)
                 └─> a2x-internal-router (fly.dev) ─ oai2a2a 게이트웨이
                      └─> vicoop-bridge-server (fly.dev, WSS) ─ 라우터
                           └─> 로컬 vicoop-client daemon (agent_id=ven-codex-local-home)
                                └─> spawns `vicoop-codex call`
                                     └─> ChatGPT (gerraldtech@gmail.com 계정 OAuth)
```

**Tool path** (이미지 생성):

```
LlmAgent 가 tool 실행을 결정
  └─> apps/web-vicoop-test/src/lib/agent/tools/{list,execute,wait}Workflow.ts
       └─> apps/mcp-server REST API (http://127.0.0.1:3333)
            └─> ComfyUI 백엔드
                 └─> Tigris S3 (fly.storage.tigris.dev / 버킷=morning-frog-3454) 업로드
                      └─> 결과 URL 반환
```

두 경로 합치는 곳: `apps/web-vicoop-test`의 `LlmAgent`. LLM이 도구 호출하면 그 자리에서 HTTP로 mcp-server 부르고, 결과를 다음 turn에 LLM 컨텍스트로 넣고, LLM이 최종 텍스트(URL 포함) 응답을 돌려준다.

## 2. 사전 요구사항

### 2.1 설치된 CLI

| 도구 | 설치 위치 (Windows nvm4w 기준) | 검증 명령 |
|---|---|---|
| `vicoop-client` | `C:\nvm4w\nodejs\vicoop-client.cmd` | `vicoop-client --version` |
| `vicoop-codex` | `C:\nvm4w\nodejs\vicoop-codex.cmd` | `vicoop-codex --version` |
| `pnpm` | `C:\nvm4w\nodejs\pnpm.cmd` | `pnpm --version` |
| `flyctl` | `C:\Users\<u>\.fly\bin\flyctl.exe` | `flyctl version` |
| `gh` | (Git for Windows 포함) | `gh auth status` |
| `curl` | Git Bash 내장 | `curl --version` |

### 2.2 인증 상태

세 계정 인증이 모두 살아 있어야 함.

```bash
# (1) ChatGPT OAuth — vicoop-codex 가 모델 호출에 사용
vicoop-codex whoami
# 기대: email/plan/account-id 출력. 만료됐으면: vicoop-codex login

# (2) vicoop-bridge owner-session — agent 등록·관리 시 필요 (이미 등록돼 있으면 매번 필요 X)
vicoop-client auth whoami
# 만료됐으면: vicoop-client auth login  (Google OAuth device flow)

# (3) Fly — storage(Tigris) 자격증명 발급 시 필요. 평소엔 없어도 됨.
flyctl auth whoami
# 필요 시: flyctl auth login  (브라우저)
```

### 2.3 환경 / 자격증명 파일

| 파일 | 역할 | 핵심 키 |
|---|---|---|
| `~/.vicoop/config.json` | daemon 자격증명 | `server_url`, `server_token`, `agent_id` |
| `~/.vicoop/owner-session.json` | owner-session 토큰 (admin용) | bearer |
| `~/.vicoop-codex/` | vicoop-codex CLI OAuth credentials | (자동) |
| `apps/web-vicoop-test/.env` | Next.js dev 서버 env | `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`, `A2A_API_KEY`, `MCP_API_URL`, `MCP_API_KEY`, `BASE_URL` |
| `apps/mcp-server/.env` | mcp-server env | `TIGRIS_BUCKET`, `TIGRIS_ACCESS_KEY_ID`, `TIGRIS_SECRET_ACCESS_KEY` (+ ComfyUI URL 등) |

#### `~/.vicoop/config.json` (예시)

```json
{
  "server_url": "wss://vicoop-bridge-server.fly.dev",
  "server_token": "<one-time AGENT_TOKEN — agent register 시 한 번만 출력됨>",
  "agent_id": "ven-codex-local-home"
}
```

만약 없거나 새로 발급해야 한다면:

```bash
vicoop-client auth login                                                 # owner-session 발급
vicoop-client agent register --name ven-codex-local-home \
                             --agent-id ven-codex-local-home              # config.json 자동 작성
```

#### `apps/web-vicoop-test/.env` (핵심 값)

```
OPENAI_API_KEY=o2a-live-<...>
OPENAI_BASE_URL=https://a2x-internal-router.fly.dev/api/v1
OPENAI_MODEL=ven-codex-local-home
BASE_URL=http://localhost:3000
A2A_API_KEY=<X-API-Key 헤더 값>
MCP_API_URL=http://127.0.0.1:3333
MCP_API_KEY=<mcp-server 인증 키>
```

`OPENAI_MODEL`은 OpenAI 모델 이름이 아니라 **agent_id** (라우터가 이 값으로 vicoop-bridge agent를 골라서 라우팅함).

#### `apps/mcp-server/.env` (Tigris 핵심)

```
TIGRIS_BUCKET=morning-frog-3454
TIGRIS_ACCESS_KEY_ID=<Tigris console 발급>
TIGRIS_SECRET_ACCESS_KEY=<Tigris console 발급>
# 선택:
TIGRIS_ENDPOINT=https://fly.storage.tigris.dev
TIGRIS_REGION=auto
```

Tigris 키 만료/없을 때: `flyctl storage dashboard morning-frog-3454` 로 콘솔 열어 Access Keys에서 **read+write 권한**으로 새 키 발급. (read-only 키는 `wait_workflow` 가 `Access Denied` 에러로 죽음.)

### 2.4 외부 의존성 (관리 대상 아님 — 살아 있는지만 확인)

- `https://vicoop-bridge-server.fly.dev` (fly app `vicoop-bridge-server`, org `vicoop-797`)
- `https://a2x-internal-router.fly.dev` (fly app `a2x-internal-router`)
- ComfyUI 백엔드 (mcp-server의 `MCP_API_URL` 또는 그 내부 ComfyUI WS 설정이 가리키는 곳)
- Tigris 버킷 `morning-frog-3454`

문제 발생 시 `flyctl status -a <app>`로 살아 있는지 빠르게 확인.

## 3. 컴포넌트 기동

세 프로세스가 모두 떠야 e2e가 동작한다. **순서는 무관**하지만 daemon이 bridge 연결을 잡는 데 1~2초 걸리므로 daemon은 일찍 띄우는 게 편하다.

### 3.1 vicoop-client daemon

```bash
vicoop-client --backend vicoop-codex
```

성공 시 stdout:

```
[client] backend: vicoop-codex
[client] connected, sending hello
[client] agentId:    ven-codex-local-home
[client] mention:    @ven-codex-local-home@vicoop-bridge-server.fly.dev
[client] a2a:        https://vicoop-bridge-server.fly.dev/agents/ven-codex-local-home
```

이게 안 뜨면 (1) `~/.vicoop/config.json` 누락, (2) `vicoop-codex` 미인증, (3) Windows ENOENT (다음 섹션 참고) 중 하나.

### 3.2 mcp-server

```bash
cd /d/workspace/a2x/a2x-comfyui-gen
pnpm --filter @a2x-comfyui-gen/mcp-server dev
```

성공 시 stdout:

```
[mcp-server] listening on http://127.0.0.1:3333 (MCP: /mcp, REST: /api, 1 API key(s) loaded)
[comfyui] shared ws connected (clientId=<uuid>)
```

`comfyui shared ws connected` 가 안 뜨면 ComfyUI 백엔드 자체가 죽어 있거나 mcp-server `.env` 의 ComfyUI URL이 잘못된 것.

### 3.3 web-vicoop-test

```bash
cd /d/workspace/a2x/a2x-comfyui-gen
pnpm --filter @a2x-comfyui-gen/web-vicoop-test dev
```

성공 시 stdout:

```
▲ Next.js 16.2.6 (Turbopack)
- Local: http://localhost:3000
✓ Ready in <N>ms
```

### 3.4 한 번에 띄우기

별도 셸 셋이 필요하니 각 명령을 백그라운드로 보내거나 별도 터미널/Claude `run_in_background` 로:

```bash
vicoop-client --backend vicoop-codex                                            &  # &  당장 fg가 필요 없다는 의미
cd /d/workspace/a2x/a2x-comfyui-gen && pnpm --filter @a2x-comfyui-gen/mcp-server      dev &
cd /d/workspace/a2x/a2x-comfyui-gen && pnpm --filter @a2x-comfyui-gen/web-vicoop-test dev &
```

Claude 세션 안에서는 각각 `Bash run_in_background: true` 로 보내고 `bg-task-id`를 기록해 두면 stdout 추적 가능.

### 3.5 모든 프로세스 종료

```powershell
# PowerShell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object {
    $_.CommandLine -like '*vicoop-bridge/client*' -or
    $_.CommandLine -like '*web-vicoop-test*' -or
    $_.CommandLine -like '*mcp-server*src/index.ts*'
  } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

남은 프로세스 확인:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'vicoop|web-vicoop-test|mcp-server' } |
  Select-Object ProcessId, CommandLine | Format-List
```

## 4. e2e 호출

### 4.1 body 파일 작성 (한글 UTF-8 필수)

Bash 의 `-d` literal 안 한글은 Git Bash 환경에서 CP949로 깨질 수 있다. **반드시 파일에 적고 `--data-binary @file`로 보낸다.**

```bash
cat > /tmp/e2e-body.json <<'EOF'
{
  "jsonrpc": "2.0",
  "id": "1",
  "method": "message/send",
  "params": {
    "message": {
      "role": "user",
      "parts": [{ "kind": "text", "text": "aki 이미지 생성해줘" }],
      "messageId": "msg_6bb53d9e-cf9e-465c-b574-95ef222e33fa"
    }
  }
}
EOF

# 검증 (UTF-8 한글 정상 출력이어야 함):
sha256sum /tmp/e2e-body.json
node -e "process.stdout.write(require('fs').readFileSync('/tmp/e2e-body.json','utf8'))"
```

5-image batch 예:

```bash
cat > /tmp/e2e-body-5.json <<'EOF'
{
  "jsonrpc": "2.0",
  "id": "2",
  "method": "message/send",
  "params": {
    "message": {
      "role": "user",
      "parts": [{ "kind": "text", "text": "aki, hana, kira, koharu, misaki 이미지를 각각 하나씩 생성해서 url 5개를 전부 알려줘." }],
      "messageId": "msg_5img_001"
    }
  }
}
EOF
```

### 4.2 POST

```bash
# A2A_API_KEY 값은 apps/web-vicoop-test/.env 에서 가져옴.
API_KEY=$(grep '^A2A_API_KEY=' /d/workspace/a2x/a2x-comfyui-gen/apps/web-vicoop-test/.env | cut -d= -f2)

curl -s -X POST http://localhost:3000/api/a2a \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  --data-binary @/tmp/e2e-body.json
```

응답 형태 (성공):

```json
{
  "jsonrpc": "2.0",
  "id": "1",
  "result": {
    "id": "<task-id>",
    "contextId": "<ctx-id>",
    "status": { "state": "TASK_STATE_COMPLETED", "timestamp": "..." },
    "artifacts": [
      {
        "artifactId": "...-text",
        "parts": [{ "text": "https://morning-frog-3454.fly.storage.tigris.dev/Aki/...png" }]
      }
    ]
  }
}
```

응답 파싱 헬퍼:

```bash
curl -s ... | node -e "
let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
  const r=JSON.parse(d).result;
  console.log('state:', r.status?.state);
  (r.artifacts||[]).flatMap(a=>a.parts||[]).forEach(p=>{
    if(p.text) console.log('text:', p.text.slice(0,300));
    if(p.url)  console.log('url :', p.url);
  });
  if(r.status?.message?.parts) console.log('FAIL msg:', r.status.message.parts[0]?.text);
});"
```

### 4.3 실패 응답 예

```json
{ "result": { "status": {
  "state": "TASK_STATE_FAILED",
  "message": { "parts": [{ "text": "Agent exceeded 25 iterations without completing." }] }
} } }
```

→ 모델이 루프에 빠진 것. 6장 디버깅 참고.

```json
"text": "502 spawn_failed: failed to spawn vicoop-codex: spawn vicoop-codex ENOENT"
```

→ Windows daemon이 vicoop-codex CLI를 못 찾음. 7.2 참고.

## 5. 모니터링

### 5.1 각 서비스 로그

Claude 세션에서 백그라운드 task ID를 알면:

```bash
tail -f /c/Users/analy/AppData/Local/Temp/claude/.../tasks/<bg-task-id>.output
```

key 라인 패턴:

| 컴포넌트 | 정상 신호 | 위험 신호 |
|---|---|---|
| `vicoop-client` daemon | `task.assign taskId=...` / `task.complete taskId=... elapsedMs=...` | `task.fail`, `disconnected: 4009`, `spawn_failed` |
| `mcp-server` | `[comfyui] shared ws connected` | `Tigris not configured`, `Access Denied`, `ECONNREFUSED` |
| `web-vicoop-test` | `POST /api/a2a 200 in <N>s` | `Error`, `Unhandled`, 401, 500 |

### 5.2 임시 디버그 로그 패턴

코드에 잠깐 박는 디버그 라인 — 작업 끝나면 반드시 원복. ESM 환경이므로 `import` 가 아니라 dynamic `require` 호출에 try/catch.

**(A) `apps/web-vicoop-test/src/lib/agent/comfyui-agent.ts` — LLM 이벤트 추적용**

`createComfyUiAgent` 의 `beforeToolCallback` 안 또는 LlmAgent 외부에서 사용하려면 BaseAgent wrapper 일시 도입이 필요하지만, **tool 호출 직전 인자만 보고 싶다면**:

```ts
beforeToolCallback: async (tool, args, context) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs');
    fs.appendFileSync(
      'D:/tmp/comfyui-agent-debug.log',
      `${new Date().toISOString()} tool=${tool.name} args=${JSON.stringify(args)}\n`,
    );
  } catch {
    // best-effort
  }
  // 기존 로직 ...
}
```

전체 LLM 이벤트 스트림을 보려면 일시적으로 BaseAgent wrapper 도입:

```ts
export class DebugWrapper extends BaseAgent {
  constructor(private readonly inner: LlmAgent) { super({ name: inner.name }); }
  async *run(ctx: InvocationContext) {
    const fs = require('node:fs');
    for await (const ev of this.inner.run(ctx)) {
      fs.appendFileSync('D:/tmp/debug.log',
        `${new Date().toISOString()} ${JSON.stringify(ev).slice(0,500)}\n`);
      yield ev;
    }
  }
}
```

**(B) `vicoop-bridge` daemon — raw A2A frame 캡처**

`packages/client/src/client.ts`의 `ws.on('message', (raw) => { … })` 블록 상단에 (ESM import 필요):

```ts
import { appendFileSync as __debugAppendFileSync } from 'node:fs';
// ...
ws.on('message', (raw) => {
  const rawText = typeof raw === 'string' ? raw : raw.toString('utf8');
  try {
    __debugAppendFileSync('D:/tmp/bridge-rawframe.log',
      `${new Date().toISOString()} ${rawText}\n`);
  } catch {}
  // 기존 로직 ...
});
```

`pnpm build` 후 daemon 재기동 필요. 글로벌 설치 위치(`C:\nvm4w\nodejs\node_modules\@vicoop-bridge\client`)가 워크스페이스 `dist` 를 그대로 가리키는지 확인 — 보통 그렇다.

**HMR 주의**: Next.js Turbopack이 server-side 모듈 변경을 항상 즉시 잡는 건 아님. comfyui-agent.ts 같은 핵심 파일을 수정한 뒤 디버그 로그가 안 찍히면 dev 서버를 한 번 재기동한다.

### 5.3 Monitor 도구로 실시간 알림

Claude 의 Monitor 도구 사용 시:

```
Monitor command:
  tail -n 0 -f /d/tmp/comfyui-agent-debug.log

또는 vicoop-bridge daemon 핵심 라인만:
  tail -n 0 -f .../tasks/<daemon-bg-id>.output | \
    grep --line-buffered -E "task.assign|task.complete|task.fail|disconnect|error|fail"
```

`persistent: true`로 켜두면 한 번에 한 라인씩 알림이 온다.

## 6. 디버깅 플레이북

증상 → 가능 원인 → 확인/조치 순.

### 6.1 `Agent exceeded N iterations without completing`

모델이 도구 루프에 갇힘.

1. `D:/tmp/comfyui-agent-debug.log` 의 이벤트 스트림 확인.
2. 패턴 분석:
   - 8회 연속 `list_workflows` → 시스템 프롬프트가 약함 + `beforeToolCallback` 가드가 없거나 무력화됨. `apps/web-vicoop-test/src/lib/agent/comfyui-agent.ts` 의 가드와 `system-prompts.ts` 의 "EXACTLY ONCE" 규칙 확인.
   - `execute` 후 `list`만 반복 (wait 진입 못 함) → 같은 원인.
   - `wait` 후에도 도구 계속 호출 → 시스템 프롬프트의 "After wait_workflow ... IMMEDIATELY reply with text" 규칙 누락.
3. 한글 입력에서 더 잘 발생 — 모델이 영문 description과 한글 prompt 매칭에 자신 없어서 list_workflows를 반복. 가드 + 강한 프롬프트가 본질적 해결책.

### 6.2 `spawn vicoop-codex ENOENT` (Windows)

Daemon이 `vicoop-codex.cmd` shim을 못 찾음.

- 픽스가 적용된 dist를 쓰고 있는지 확인:
  ```bash
  grep "shell" /c/nvm4w/nodejs/node_modules/@vicoop-bridge/client/dist/backends/vicoop-codex.js
  ```
  `shell: process.platform === 'win32'` 라인이 보여야 함. 없으면 `pnpm build` 안 돈 것 또는 워크스페이스 dist 가 글로벌 위치를 가리키지 않는 것.
- 워크스페이스 ↔ 글로벌 install 동일성 확인:
  ```bash
  ls -la /c/nvm4w/nodejs/node_modules/@vicoop-bridge/client/dist/backends/vicoop-codex.js
  ls -la /d/workspace/a2a/vicoop-bridge/packages/client/dist/backends/vicoop-codex.js
  # 두 파일 inode/size 같아야 (junction/symlink)
  ```
- 영구 수정은 `packages/client/src/backends/vicoop-codex.ts`(+ `codex-rpc.ts`)에 `shell: process.platform === 'win32'` 박혀 있어야 함. PR #254 참고.

### 6.3 `disconnected: 4009 replaced by new connection`

같은 token으로 두 개 이상의 daemon 인스턴스가 동시에 bridge에 접속.

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*vicoop-bridge/client*' } |
  Select-Object ProcessId, CommandLine | Format-List
```

여러 개 보이면 — 보통 `TaskStop`이 백그라운드 wrapper만 죽이고 자식 node를 좀비로 남긴 결과 — 명시적으로 모두 죽인다:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*vicoop-bridge/client*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

다른 머신에서 같은 자격증명을 쓰는 daemon이 있는지도 의심:

```bash
vicoop-client agent list --connected --json
```

`agent_id=ven-codex-local-home` 인 connected client가 여러 개면 거기서 죽여야 함.

### 6.4 `Error: Tigris not configured` (wait_workflow)

mcp-server의 `.env` 에서 `TIGRIS_BUCKET` / `TIGRIS_ACCESS_KEY_ID` / `TIGRIS_SECRET_ACCESS_KEY` 누락. 2.3 참고.

### 6.5 `Access Denied` (wait_workflow)

Tigris 자격증명은 잡혔지만 키 권한 부족.

- `flyctl storage dashboard morning-frog-3454` 콘솔 열어 키의 권한 확인.
- read-only면 동작 안 함. **Editor / Admin / read+write 권한**으로 새 키 발급 → mcp-server `.env` 갱신 → mcp-server 재시작.

### 6.6 한글 깨짐 / `aki ???` 같은 입력

curl `-d` literal 한글이 CP949로 인코딩됨. **반드시 파일에 적고 `--data-binary @file`** (4.1 참고).

확인:

```bash
node -e "process.stdout.write(require('fs').readFileSync('/tmp/e2e-body.json','utf8'))"
# 정상 한글이 보여야 함.
```

bridge daemon 측 raw frame 캡처해서 `parts.text` 의 hex가 `ec9db4 ebafb8 eca780 ...` (정상 UTF-8) 인지 `efbfbd ...` (U+FFFD 대체문자) 인지 확인.

### 6.7 호출이 다른 dev 서버로 갔는지 의심될 때

내가 띄운 dev 서버에 로그가 없으면 누군가 다른 인스턴스가 `:3000` 을 잡고 있을 가능성.

```powershell
Get-NetTCPConnection -LocalPort 3000 -State Listen |
  ForEach-Object {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)"
    Write-Output "PID=$($_.OwningProcess) cmd=$($p.CommandLine)"
  }
```

내가 띄운 게 아니면 죽이고 (또는 다른 포트로 시작하고) 다시.

## 7. 검증 시나리오

새 세션에서 e2e 가 살아 있는지 확인할 때 돌리는 표준 케이스.

### 7.1 단일 이미지 (happy path)

```bash
curl -s -X POST http://localhost:3000/api/a2a \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  --data-binary @/tmp/e2e-body.json
```

기대: `state=TASK_STATE_COMPLETED`, `artifacts[0].parts[0].text` 가 `https://morning-frog-3454.fly.storage.tigris.dev/Aki/<uuid>.png` 포함.

소요 시간: ~10~30초 (도구 호출 3회 + 모델 turn 4~5회).

### 7.2 5-image 배치 (parallel tool_calls 검증)

```bash
curl -s -X POST http://localhost:3000/api/a2a \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  --data-binary @/tmp/e2e-body-5.json
```

기대: `state=TASK_STATE_COMPLETED`, text artifact 안에 5개 URL.

소요 시간: ~60~120초. 모델이 parallel tool_calls 잘 쓰면 4~5 turns 만에 끝남.

### 7.3 reliability 체크 (선택)

연속 호출:

```bash
for i in 1 2 3; do
  state=$(curl -s -X POST http://localhost:3000/api/a2a \
    -H "Content-Type: application/json" \
    -H "X-API-Key: $API_KEY" \
    --data-binary @/tmp/e2e-body.json | \
    node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).result.status.state));")
  echo "run $i: $state"
done
```

3회 다 `TASK_STATE_COMPLETED` 면 충분히 stable.

## 8. 참고 — 코드 위치 / 외부 endpoint

### 8.1 핵심 파일

- ComfyUiAgent (LlmAgent 팩토리): `D:\workspace\a2x\a2x-comfyui-gen\apps\web-vicoop-test\src\lib\agent\comfyui-agent.ts`
- 시스템 프롬프트: `apps\web-vicoop-test\src\lib\agent\system-prompts.ts`
- BaseTool 정의: `apps\web-vicoop-test\src\lib\agent\tools\baseTools.ts`
- 도구 핸들러 (mcp-server REST 클라이언트): `apps\web-vicoop-test\src\lib\agent\tools\{list,execute,wait}Workflow.ts`
- A2A 엔드포인트 라우트: `apps\web-vicoop-test\src\app\api\a2a\route.ts`
- A2A 인증: `apps\web-vicoop-test\src\lib\auth.ts`
- mcp-server Tigris 클라이언트: `D:\workspace\a2x\a2x-comfyui-gen\apps\mcp-server\src\services\storage\tigris.ts`
- vicoop-bridge daemon backend (vicoop-codex): `D:\workspace\a2a\vicoop-bridge\packages\client\src\backends\vicoop-codex.ts`
- vicoop-bridge daemon WS 핸들러: `D:\workspace\a2a\vicoop-bridge\packages\client\src\client.ts`

### 8.2 외부 endpoint

| 이름 | URL | 비고 |
|---|---|---|
| vicoop-bridge WS | `wss://vicoop-bridge-server.fly.dev` | daemon 연결 |
| vicoop-bridge HTTPS | `https://vicoop-bridge-server.fly.dev` | owner-session OAuth, agent register, agent card |
| a2x-internal-router | `https://a2x-internal-router.fly.dev/api/v1` | OpenAI-compatible 게이트웨이. `OPENAI_BASE_URL` 가 가리킴 |
| Tigris 콘솔 | `https://console.storage.dev` | 액세스 키 발급 (사용자 fly 계정으로 로그인) |
| Tigris bucket URL prefix | `https://morning-frog-3454.fly.storage.tigris.dev` | 생성된 이미지 public URL |
| fly org | slug `vicoop-797` | `flyctl storage list -o vicoop-797` |

### 8.3 자격증명 위치 요약

| 키 | 어디서 | 노출 OK? |
|---|---|---|
| `~/.vicoop/config.json` `server_token` | agent register 시 한 번만 발급 | 비공개 (로컬 file 0600) |
| `apps/web-vicoop-test/.env` `A2A_API_KEY` | X-API-Key 헤더 값 | 비공개 (로컬 .env) |
| `apps/web-vicoop-test/.env` `OPENAI_API_KEY` (`o2a-live-…`) | a2x-internal-router 인증 키 | 비공개 |
| `apps/mcp-server/.env` `TIGRIS_*` | Tigris 콘솔 발급 | 비공개 |

문서나 PR description 에는 절대 적지 말 것. `.env` 는 `.gitignore` 에 들어 있는지 확인.

## 9. 새 세션 체크리스트 (요약)

1. **세 컴포넌트 기동 확인** (3장): daemon `connected, sending hello`, mcp-server `comfyui ws connected`, web-vicoop-test `Ready in`.
2. **body 파일 작성** (4.1): 한글은 반드시 파일 + `--data-binary @`.
3. **`A2A_API_KEY` 헤더로 POST** (4.2).
4. **응답 state 확인** (4.2). `COMPLETED` 면 끝.
5. 실패 시 6장 플레이북. 특히:
   - 8회 cap 초과 → 모델 루프, 가드/프롬프트 확인
   - `spawn ENOENT` → Windows shim 미적용
   - `4009` → 중복 daemon
   - `Tigris not configured` / `Access Denied` → mcp-server `.env`

이 5단계로 안 풀리면 5.2 디버그 로그 박고 5.3 Monitor 로 실시간 추적.
