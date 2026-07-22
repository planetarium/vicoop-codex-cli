# vicoop-codex-cli

## 0.8.2

### Patch Changes

- d3443c0: responses: retry transient upstream error statuses (520/5xx) before first byte

  A transient HTTP 520 (or any received-but-error 5xx) from the ChatGPT backend
  was never retried: the `UPSTREAM_MAX_RETRIES` path only covered the stall case
  (no response headers within the first-header watchdog), so once headers
  arrived — even with a 520 — the error was returned as-is. With a single
  enabled account the cross-account fallback had no target either, so one
  transient Cloudflare 520 failed the user request outright (#45).

  `postUpstream` now treats a retryable received status (5xx, 408, 409, 425,
  429 — deliberately excluding 401/403, which a same-account retry cannot fix)
  arriving before any body bytes as retryable: the body is cancelled and a fresh
  connection is attempted, sharing the existing attempt budget
  (`VICOOP_CODEX_UPSTREAM_MAX_RETRIES`) and absolute deadline with the stall
  path. Bad-status retries pause `VICOOP_CODEX_UPSTREAM_RETRY_BACKOFF_MS`
  (default 1s, scaled by attempt, capped at 30s; a `Retry-After` header takes
  precedence) between attempts. Hopeless cases skip the retry and return the
  concrete error response instead: a `Retry-After` beyond the cap (hard-quota 429) or under 10s of deadline remaining. The last attempt's response is still
  returned as-is, so downstream error formatting is unchanged. Logged as
  `phase:"retry", when:"bad_status"` in the `[upstream]` instrumentation.

- c4dc30c: serve: self-terminate when the parent process dies (orphan watchdog)

  Under the bridge, `vicoop-client` spawns `vicoop-codex serve` as a child
  without `detached`, and several of the client's exit paths (a fatal WS close,
  an uncaughtException, SIGKILL) tear the client down without signaling the
  child. Node delivers no signal to a child when its parent dies, so an orphaned
  `serve` kept LISTENing forever — a leaked ephemeral port and a stale process
  that accumulated one generation per client restart.

  `serve` now polls `process.ppid` and shuts itself down once the parent it was
  spawned under goes away (reparented to init / a subreaper). Direct runs (a TTY,
  or a real supervisor as pid 1) start with ppid 1 and are left untouched. Also
  handles SIGHUP as a graceful stop. Disable with
  `VICOOP_CODEX_SERVE_PARENT_WATCH=0`; tune the poll with
  `VICOOP_CODEX_SERVE_PARENT_WATCH_MS` (default 5000).

  Note: this intentionally overrides the ad-hoc `nohup vicoop-codex serve &` /
  `disown` idiom (which blocks SIGHUP but not reparenting). Proper daemonization
  (`setsid`/systemd/launchd/docker as pid 1) starts with ppid 1 and is unaffected
  by the `ppid <= 1` guard; standalone background users can set
  `VICOOP_CODEX_SERVE_PARENT_WATCH=0`.

## 0.8.1

### Patch Changes

- Remove the unused A2A surface from `serve` ([#40](https://github.com/planetarium/vicoop-codex-cli/pull/40)).

## 0.8.0

### Minor Changes

- `serve`/responses: abort the upstream `/responses` call on client disconnect and retry on stall ([#38](https://github.com/planetarium/vicoop-codex-cli/pull/38)).

## 0.7.2

### Minor Changes

- responses: add a file sink for `[upstream]` logs ([#36](https://github.com/planetarium/vicoop-codex-cli/pull/36)).

## 0.7.1

### Minor Changes

- responses: instrument the raw upstream `/responses` call (first-byte / status / totals) ([#35](https://github.com/planetarium/vicoop-codex-cli/pull/35)).

## 0.7.0

### Minor Changes

- models: surface `context_window` on the models catalog ([#34](https://github.com/planetarium/vicoop-codex-cli/pull/34)).
