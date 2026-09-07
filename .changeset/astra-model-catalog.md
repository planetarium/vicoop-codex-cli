---
"vicoop-codex-cli": patch
---

Bump the Codex backend client version to 0.153.4 so `models` exposes gpt-6-astra on eligible accounts (#51). Astra and catalog requests retain the legacy User-Agent; only the gpt-5.6-luna family uses the official Codex CLI signature.

Catalog order continues to follow the backend response. Consumers that select the first model as their default may now select gpt-6-astra. After release, update the provider's vicoop-codex installation and restart `vicoop-bridge-vicoop-codex.service` to refresh the advertised catalog.

Forward caller-supplied `prompt_cache_key` values as the upstream `session_id` header for `call`, `serve`, and programmatic prompt requests. The subscription backend replaces body-only keys with fresh UUIDs; a stable session header enables cache reuse across matching requests. Keys with non-visible-ASCII characters or more than 256 characters are SHA-256 hashed for the header only. Missing keys retain the existing behavior. Account selection remains unchanged, so cache reuse across requests that select different accounts is not guaranteed.
