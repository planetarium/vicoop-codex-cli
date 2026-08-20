---
"vicoop-codex-cli": patch
---

fix(cache): present the `codex_cli_rs` User-Agent only for gpt-5.6-luna, restoring the cache-safe legacy UA everywhere else

Since 0.6.4 every backend call presented the official Codex CLI signature
(`codex_cli_rs/<version>`), which the ChatGPT Codex backend takes as a modern
client identity — and which demonstrably collapses prompt-cache hit rates:
production hit *ratio* fell 78–93% → 30–51% across all models right at the
0.6.4 rollout, and a controlled same-day A/B on gpt-5.6-sol (v0.6.3 vs v0.8.2,
interleaved, Fisher p=0.032) measured 27.0% vs 5.6% — a ~5x drop attributable
to the UA alone (#48).

The signature is only actually required by gpt-5.6-luna (its engine 404s on any
other UA; openai/codex#31967), so the UA is now selected per request:
luna-family models get `codex_cli_rs/<version>`, every other model — and every
model-less call (GET /models, the usage endpoint) — goes back to the legacy
`vicoop-codex-cli/0.1.0` identity that ran cache-healthy through 0.6.3. The
`/models` catalog is unaffected (gated by the `client_version` query param, not
the UA; full 5.6 family verified listing under the legacy UA), and live checks
confirm gpt-5.6-luna / gpt-5.6-sol / gpt-5.5 all answer 200 through the
patched build.
