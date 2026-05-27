# vicoop-codex-cli

A **minimal** Codex-style CLI written in TypeScript. It signs you in to your **ChatGPT subscription via OAuth (PKCE)** and uses the resulting access token to call the ChatGPT backend LLM endpoint — no tools, no sandbox, no file editing. Just prompt-in → response-out.

This project is a stripped-down, language-ported reimplementation of the OAuth + LLM-call subset of the upstream Rust [`codex-rs`](https://github.com/openai/codex). It targets developers who want to script against their ChatGPT plan with the lightest possible client.

## What it does

- `vicoop-codex login` — opens a browser, performs the OAuth PKCE flow, stores tokens locally.
- `vicoop-codex "your prompt"` — sends a one-shot prompt and streams the response.
- Automatic token refresh on `401`.
- Optional non-streaming or JSON output.

## What it does **not** do

- No tool calls / function calling.
- No filesystem or shell sandbox.
- No REPL / conversation memory across runs.
- No support for OpenAI Platform API keys (use the official `openai` CLI for that — this one is ChatGPT-subscription-only by design).

## Requirements

- Node.js **20+** (uses the built-in `fetch` and `ReadableStream`).
- A ChatGPT account on a plan that grants Codex access (Plus / Pro / Team / Enterprise / Edu).

## Install

```bash
cd vicoop-codex-cli
npm install            # install dev deps
npm run cli:install    # build + `npm install -g .` (exposes the `vicoop-codex` command)
```

To remove the global command later:

```bash
npm run cli:uninstall
```

Or run without installing globally:

```bash
npm run build
node ./bin/vicoop-codex.js "hello"
```

## Usage

```bash
# 1) Authenticate (one-time per machine)
vicoop-codex login

# 2) Send prompts
vicoop-codex "Explain monads in one paragraph"

# Pipe stdin into the prompt
git diff | vicoop-codex "Summarize this diff in three bullets"

# Choose a model
vicoop-codex -m gpt-5 "What changed?"

# Higher reasoning effort
vicoop-codex -r high "Why does this algorithm have O(n log n) complexity?"

# Buffer the full response instead of streaming
vicoop-codex --no-stream "Give me a haiku"

# Structured output for scripts
vicoop-codex --json "List 3 advantages of TLA+" | jq -r .text

# List currently advertised Codex backend models
vicoop-codex models --json

# Inspect the signed-in account
vicoop-codex whoami

# Sign out
vicoop-codex logout
```

## How auth works

Credentials are stored in `~/.vicoop-codex/auth.json` (mode `0600`). Override the directory with `VICOOP_CODEX_HOME=/some/path`.

The flow:

1. CLI generates a PKCE pair and a random state.
2. CLI starts a local HTTP server on `127.0.0.1:1455` (fallback `1457`) listening at `/auth/callback`.
3. CLI opens `https://auth.openai.com/oauth/authorize?…` in the user's browser.
4. After the user signs in, OpenAI redirects back to the local server with `?code=…&state=…`.
5. CLI exchanges the code at `https://auth.openai.com/oauth/token` and stores `id_token`, `access_token`, `refresh_token`, plus the `chatgpt_account_id` claim.

On every LLM request, the CLI:

1. Refreshes the access token proactively if the JWT `exp` claim is within 60 s of now.
2. Sends `Authorization: Bearer …` plus `ChatGPT-Account-ID: …` to `https://chatgpt.com/backend-api/codex/responses`.
3. If the response is `401`, refreshes once and retries.

## Architecture

```
src/
├─ auth/
│  ├─ constants.ts     OAuth endpoints, client id, scopes, redirect paths
│  ├─ pkce.ts          code_verifier / code_challenge / state
│  ├─ jwt.ts           decode id_token, extract chatgpt_account_id, isExpired
│  ├─ server.ts        local 127.0.0.1 callback HTTP server
│  ├─ oauth.ts         token exchange + refresh requests
│  ├─ login.ts         end-to-end PKCE login flow
│  ├─ manager.ts       loadActiveAuth + forceRefresh (used by client)
│  └─ store.ts         read/write/clear ~/.vicoop-codex/auth.json
├─ client/
│  ├─ backend.ts       shared ChatGPT Codex backend fetch + auth refresh
│  ├─ models.ts        GET /backend-api/codex/models + model list normalization
│  ├─ sse.ts           minimal text/event-stream parser
│  └─ responses.ts     POST /backend-api/codex/responses + stream parsing
├─ commands/
│  ├─ login.ts         login subcommand
│  ├─ logout.ts        logout subcommand
│  ├─ models.ts        models subcommand
│  ├─ whoami.ts        whoami subcommand
│  └─ prompt.ts        default one-shot prompt subcommand
└─ index.ts            argv parser + dispatcher (exported `main()`)
```

Zero runtime dependencies — only `typescript` and `@types/node` at build time.

## License

Same license terms as the upstream Codex project.
