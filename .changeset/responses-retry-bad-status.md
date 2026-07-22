---
"vicoop-codex-cli": patch
---

responses: retry transient upstream error statuses (520/5xx) before first byte

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
concrete error response instead: a `Retry-After` beyond the cap (hard-quota
429) or under 10s of deadline remaining. The last attempt's response is still
returned as-is, so downstream error formatting is unchanged. Logged as
`phase:"retry", when:"bad_status"` in the `[upstream]` instrumentation.
