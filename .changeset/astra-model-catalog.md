---
"vicoop-codex-cli": patch
---

Bump the Codex backend client version to 0.153.4 so `models` exposes gpt-6-astra on eligible accounts (#51). Astra and catalog requests retain the legacy User-Agent; only the gpt-5.6-luna family uses the official Codex CLI signature.

Catalog order continues to follow the backend response. Consumers that select the first model as their default may now select gpt-6-astra instead of gpt-reserve. Before provider rollout, decide the bridge's default-model policy and check the affected accounts' Astra limits. After release, update the provider's vicoop-codex installation and restart `vicoop-bridge-vicoop-codex.service` to refresh the advertised catalog.

Forward caller-supplied `prompt_cache_key` values as the upstream `session_id` header for `call`, `serve`, and programmatic prompt requests. In controlled tests, the subscription backend replaced body-only keys with fresh UUIDs, while a stable session header improved cache reuse for follow-up requests in the same conversation. Requests without this header can still get shared-prefix cache hits; the change does not guarantee a hit or a particular production hit rate. Keys with non-visible-ASCII characters or more than 256 characters are SHA-256 hashed for the header only. Missing keys retain the existing behavior. Account selection remains unchanged, so cache reuse across requests that select different accounts is not guaranteed.

Caller-provided keys now affect session-based cache routing. Reuse a stable key for related requests, scoped to the caller and conversation or other intended reuse group. An application-wide key shared by unrelated callers can concentrate traffic into one routing group and may reduce cache effectiveness or increase latency under load. The bridge's generated fallback already includes caller identity when available, but explicit caller keys take precedence and are not automatically caller-scoped by this change. Monitor daily production cache-hit rates and latency after rollout; the small repeat-request experiments are not a production forecast.
