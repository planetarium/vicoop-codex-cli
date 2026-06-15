# vicoop-codex-cli

A **minimal** Codex-style CLI written in TypeScript. It signs you in to your **ChatGPT subscription via OAuth (PKCE)** and uses the resulting access token to call the ChatGPT backend LLM endpoint — no tools, no sandbox, no file editing. Just prompt-in → response-out.

This project is a stripped-down, language-ported reimplementation of the OAuth + LLM-call subset of the upstream Rust [`codex-rs`](https://github.com/openai/codex). It targets developers who want to script against their ChatGPT plan with the lightest possible client.

## What it does

- `vicoop-codex login` — opens a browser, performs the OAuth PKCE flow, stores tokens locally.
- `vicoop-codex login --device-code` — device-code flow for headless/remote machines: prints a URL + one-time code to enter in any browser (no local callback needed).
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

## Download (prebuilt binaries)

Each release ships standalone, single-file executables — no Node.js install
required.

**macOS / Linux** — one-liner that detects your platform, resolves the latest
version, verifies the SHA256 checksum, and installs `vicoop-codex`:

```bash
curl -fsSL https://raw.githubusercontent.com/planetarium/vicoop-codex-cli/main/scripts/install.sh | sh
```

The installer drops the binary in `/usr/local/bin` (or `$HOME/.local/bin` if
that isn't writable). Override either choice with environment variables:

```bash
# pin a version and/or pick the install directory
curl -fsSL https://raw.githubusercontent.com/planetarium/vicoop-codex-cli/main/scripts/install.sh \
  | VERSION=0.2.1 INSTALL_DIR=~/bin sh
```

**Windows (PowerShell):**

```powershell
$repo = "planetarium/vicoop-codex-cli"
$ver  = (Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest").tag_name.TrimStart("v")
Invoke-WebRequest "https://github.com/$repo/releases/latest/download/vicoop-codex-$ver-windows-x64.exe" -OutFile vicoop-codex.exe
.\vicoop-codex.exe --version
```

> macOS may quarantine the downloaded binary (it is not notarized). If Gatekeeper
> blocks it, run `xattr -d com.apple.quarantine ./vicoop-codex` once.

Prefer to grab a file by hand? Every release on the
[Releases page](https://github.com/planetarium/vicoop-codex-cli/releases/latest)
attaches these assets plus a `SHA256SUMS.txt`:

| Platform | Asset |
| --- | --- |
| Windows (x64) | `vicoop-codex-<version>-windows-x64.exe` |
| macOS (Apple Silicon) | `vicoop-codex-<version>-macos-arm64` |
| Linux (x64) | `vicoop-codex-<version>-linux-x64` |
| Linux (arm64) | `vicoop-codex-<version>-linux-arm64` |

Once installed, keep it current with the built-in updater — `vicoop-codex upgrade`
(see [Upgrading](#upgrading)).

## Install (from source)

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

# ...or, on a headless / remote box, use the device-code flow
# (prints a URL + one-time code to enter in a browser on any device)
vicoop-codex login --device-code

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

# Inspect the signed-in (active) account
vicoop-codex whoami

# Sign out — pick the account to remove, or --all
vicoop-codex logout --account alice@corp.com
vicoop-codex logout --all

# Update the standalone binary in place (checks GitHub Releases, verifies SHA256)
vicoop-codex upgrade

# Just check whether a newer version exists, without installing
vicoop-codex upgrade --check
```

### Multiple accounts

You can enroll several ChatGPT accounts at once. Each request then picks one
**available** account (default: `burn-rate`, draining soonest-expiring quota
first) and **falls back** to another account if the call fails
(auth/permission/quota/transient backend error). With a single account the
behavior is identical to before.

```bash
# Enroll more accounts (same OAuth flow as `login`; `login` itself also enrolls)
vicoop-codex accounts add
vicoop-codex accounts add --device-code          # headless/remote
vicoop-codex accounts add --no-activate          # enroll without switching active

# See everything enrolled, the active account (*), and the selection strategy
vicoop-codex accounts list
vicoop-codex accounts list --json

# Switch the active account (the one mirrored into auth.json for whoami/serve)
vicoop-codex accounts use bob@home.com

# Temporarily exclude / re-include an account from automatic selection
vicoop-codex accounts disable <email|key>
vicoop-codex accounts enable  <email|key>

# Show or set the selection strategy (env VICOOP_CODEX_ACCOUNT_STRATEGY overrides)
vicoop-codex accounts strategy            # show current + available
vicoop-codex accounts strategy burn-rate  # "use-it-or-lose-it": drain soonest-expiring quota first (default)
vicoop-codex accounts strategy random     # uniform random

# Remaining Codex usage per account (5h + weekly windows; read-only, no quota cost)
vicoop-codex accounts usage
vicoop-codex accounts usage bob@home.com --json
```

When running `serve`, the same data is available over HTTP at `GET /usage`
(alias `GET /v1/usage`), returning `{ accounts: [ { key, email, plan_type, primary, secondary, credits, error } ] }`.

Accounts can be referenced by email or by the short key shown in `accounts list`.
Selection is pluggable: `burn-rate` (default; drains the account whose remaining
quota would otherwise reset soonest, i.e. remaining ÷ time-to-reset) and `random`
ship built-in; new strategies (round-robin, LRU, …) just implement one `order()`
method. See [`docs/multi-account.md`](docs/multi-account.md).

### Upgrading

The prebuilt standalone binaries can update themselves:

```bash
vicoop-codex upgrade          # download the latest release and replace this binary
vicoop-codex upgrade --check  # report whether a newer version exists, then exit
vicoop-codex upgrade --force  # re-download even if already up to date
```

`upgrade` queries the [latest GitHub Release](https://github.com/planetarium/vicoop-codex-cli/releases/latest),
picks the asset matching your platform, verifies it against `SHA256SUMS.txt`,
and atomically replaces the running executable. It only self-updates the
standalone binaries — if you installed from source or via npm, it prints the
right `git pull` / `npm install -g` command instead.

## How auth works

Credentials are stored under `~/.vicoop-codex/` (mode `0600`). Override the directory with `VICOOP_CODEX_HOME=/some/path`.

- `auth.json` — the **active** account, in the original single-account format (every existing reader keeps working).
- `accounts/<key>.json` — one file per enrolled account (the multi-account pool).
- `state.json` — `{ activeKey, strategy }`.

A pre-existing single `auth.json` is imported into the pool on first run, so upgrading is transparent. The active account is always mirrored back into `auth.json`.

The flow:

1. CLI generates a PKCE pair and a random state.
2. CLI starts a local HTTP server on `127.0.0.1:1455` (fallback `1457`) listening at `/auth/callback`.
3. CLI opens `https://auth.openai.com/oauth/authorize?…` in the user's browser.
4. After the user signs in, OpenAI redirects back to the local server with `?code=…&state=…`.
5. CLI exchanges the code at `https://auth.openai.com/oauth/token` and stores `id_token`, `access_token`, `refresh_token`, plus the `chatgpt_account_id` claim.

On every LLM request, the CLI:

1. Asks the active selection strategy for an ordered list of candidate accounts (default: `burn-rate`, which orders accounts by whose remaining quota would otherwise reset soonest).
2. For the chosen account, refreshes the access token proactively if the JWT `exp` claim is within 60 s of now.
3. Sends `Authorization: Bearer …` plus `ChatGPT-Account-ID: …` to `https://chatgpt.com/backend-api/codex/responses`.
4. If the response is `401`, refreshes once and retries that account.
5. If the account still fails with a fallback-worthy status (`401`/`403`/`408`/`409`/`425`/`429`/`5xx`) or a network error, it advances to the next candidate. Request-level errors (`400`/`404`/`413`/`422`, …) are returned as-is — they would fail the same way on any account. The last candidate's response (error or not) is always returned, so error messages are unchanged.

### Device-code flow (`login --device-code`)

For machines with no browser (servers, containers, SSH sessions), `--device-code`
uses OpenAI's device-authorization flow instead of the loopback server:

1. CLI `POST`s to `https://auth.openai.com/api/accounts/deviceauth/usercode` and gets back a one-time `user_code`.
2. CLI prints `https://auth.openai.com/codex/device` + the code; you open that URL in a browser on *any* device and enter the code (valid 15 minutes).
3. CLI polls `…/api/accounts/deviceauth/token` until you authorize, then receives an OAuth `authorization_code` + PKCE verifier.
4. CLI exchanges that at `https://auth.openai.com/oauth/token` and stores the tokens exactly like the browser flow.

> This is OpenAI's proprietary Codex device flow (not RFC 8628), ported from
> `openai/codex` `codex-rs/login/src/device_code_auth.rs`. Availability is
> controlled **server-side by OpenAI per account/client** — if it isn't enabled,
> the usercode request returns `404` and the CLI prints a guide on how to enable
> it (ChatGPT Settings → Security for personal accounts; a workspace admin for
> Team/Enterprise) plus the no-device fallbacks (`login`, `login --no-browser`,
> or an `ssh -L 1455:localhost:1455` port-forward).

## Architecture

```
src/
├─ auth/
│  ├─ constants.ts     OAuth endpoints, client id, scopes, redirect paths
│  ├─ pkce.ts          code_verifier / code_challenge / state
│  ├─ jwt.ts           decode id_token, extract chatgpt_account_id, isExpired
│  ├─ server.ts        local 127.0.0.1 callback HTTP server
│  ├─ oauth.ts         token exchange + refresh requests
│  ├─ device.ts        OpenAI device-code flow (usercode request + token poll)
│  ├─ login.ts         end-to-end PKCE login flow (loopback + device-code); enrolls into the pool
│  ├─ manager.ts       loadAuthCandidates (selection + per-account refresh) + loadActiveAuth/forceRefresh
│  ├─ account-store.ts multi-account pool: accounts/<key>.json, state.json, active mirror, migration
│  ├─ selection/       pluggable account-selection strategies (types, random, registry)
│  └─ store.ts         read/write/clear the active-account ~/.vicoop-codex/auth.json mirror
├─ client/
│  ├─ backend.ts       shared backend fetch: walks selected accounts, 401-refresh, fallback
│  ├─ usage.ts         per-account remaining usage (GET /backend-api/wham/usage)
│  ├─ models.ts        GET /backend-api/codex/models + model list normalization
│  ├─ sse.ts           minimal text/event-stream parser
│  └─ responses.ts     POST /backend-api/codex/responses + stream parsing
├─ commands/
│  ├─ login.ts         login subcommand
│  ├─ logout.ts        logout subcommand (--account <id> / --all)
│  ├─ accounts.ts      accounts subcommands (list/add/use/enable/disable/strategy)
│  ├─ models.ts        models subcommand
│  ├─ whoami.ts        whoami subcommand
│  ├─ upgrade.ts       self-update from GitHub Releases (verifies SHA256)
│  └─ prompt.ts        default one-shot prompt subcommand
└─ index.ts            argv parser + dispatcher (exported `main()`)
```

Zero runtime dependencies — only `typescript` and `@types/node` at build time.

## Releasing

Releases are **tag-driven** and fully automated by
[`.github/workflows/release.yml`](.github/workflows/release.yml). Pushing a
semver tag (`v*`) to GitHub triggers a build that cross-compiles four standalone
binaries with [Bun](https://bun.sh) (`--compile`) and publishes a GitHub Release
for that tag with the binaries + `SHA256SUMS.txt` attached.

To cut a release:

```bash
# Option A: let npm bump package.json and create the tag for you
npm version patch          # or: minor | major  (creates vX.Y.Z tag)
git push && git push --tags

# Option B: tag by hand
git tag v1.2.3
git push origin v1.2.3
```

The pushed tag is the source of truth for the version: `release.yml` strips the
leading `v` and injects it into `package.json` and `src/index.ts` (via
[`scripts/inject-version.mjs`](scripts/inject-version.mjs)) before building, so
the binary's `--version` matches the tag. Tags containing a pre-release suffix
(e.g. `v1.2.3-rc.1`) are published as GitHub pre-releases.

Build targets: `windows-x64` (.exe), `macos-arm64`, `linux-x64`, `linux-arm64`.

Merges to `main` do **not** release; they only run the build/type-check gate in
[`.github/workflows/ci.yml`](.github/workflows/ci.yml).

## License

This project is licensed under the **Apache License, Version 2.0** — see
[`LICENSE`](./LICENSE).

`vicoop-codex-cli` is a TypeScript port of the OAuth sign-in + LLM-call subset
of [OpenAI Codex](https://github.com/openai/codex) (`codex-rs`), which is also
licensed under Apache-2.0 (Copyright 2025 OpenAI). The upstream Rust source has
been reimplemented and modified in TypeScript; see [`NOTICE`](./NOTICE) for the
required attribution.

> **Trademarks & affiliation.** "Codex", "ChatGPT", and "OpenAI" are trademarks
> of OpenAI. This is an independent, unofficial project and is **not** affiliated
> with, endorsed by, or sponsored by OpenAI. Apache-2.0 grants no rights to these
> marks (§6).
