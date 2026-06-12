# Multiple accounts

`vicoop-codex` can hold credentials for several ChatGPT accounts at once. When a
request is made (`prompt`, `call`, or the `serve` HTTP / A2A surfaces), the CLI
picks one **available** account and, if that call fails, **falls back** to
another. The selection policy is pluggable.

With exactly one enrolled account, behavior is byte-for-byte identical to the
original single-account CLI.

## Concepts

- **Pool** — every enrolled account. Stored as one file per account.
- **Active account** — the account mirrored into the legacy `auth.json`. This is
  what `whoami` shows and what single-account readers see. It is *not*
  necessarily the account a given request uses — selection picks from the whole
  enabled pool.
- **Selection strategy** — decides the order in which accounts are tried for a
  request. The head of that order is the primary pick; the rest is the fallback
  order. Default: `random`.
- **Key** — a stable per-account id (from the ChatGPT `chatgpt_account_id` claim,
  falling back to the user id, then a hash of the refresh token). Shown in
  `accounts list`; usable as a selector.

## On-disk layout

Under `$VICOOP_CODEX_HOME` (default `~/.vicoop-codex`, mode `0600`):

```
auth.json              # the ACTIVE account, original single-account format (a mirror)
accounts/<key>.json    # one record per enrolled account: { auth, meta }
state.json             # { activeKey, strategy }
```

`accounts/<key>.json`:

```jsonc
{
  "auth": { "auth_mode": "chatgpt", "tokens": { ... }, "last_refresh": "..." },
  "meta": {
    "key": "user-abc123",
    "email": "alice@corp.com",
    "addedAt": "2026-06-12T...",
    "lastUsedAt": "2026-06-12T...",   // updated on a successful call
    "lastError": "HTTP 429",          // updated on a failed call
    "lastErrorAt": "2026-06-12T...",
    "disabled": false                  // excluded from selection when true
  }
}
```

**Migration is automatic:** on first run, a pre-existing single `auth.json` is
imported into the pool and marked active. Nothing to do when upgrading.

## Commands

The existing surface (`login`, `prompt`, `call`, `serve`, `models`, `whoami`,
`upgrade`) is unchanged. `login` now also enrolls the account into the pool and
makes it active. Two surfaces are new/changed:

### `accounts`

| Command | Description |
| --- | --- |
| `accounts list [--json]` | List enrolled accounts (active marked `*`), plan, enabled/disabled, last-used / last-error, and the active strategy. |
| `accounts add [--device-code] [--no-browser] [--no-activate]` | Enroll another account via the same OAuth/device flow as `login`. `--no-activate` enrolls without switching the active account (the first account is always activated). |
| `accounts use <email\|key>` | Set the active account (updates the `auth.json` mirror). |
| `accounts enable <email\|key>` | Include an account in automatic selection. |
| `accounts disable <email\|key>` | Exclude an account from automatic selection (kept enrolled). |
| `accounts strategy [name]` | Show the current/available strategies, or set one. |
| `accounts usage [email\|key] [--json]` | Show remaining Codex usage per account (5h + weekly windows). Omit the selector for all accounts. |

### `logout`

`logout` now requires a target:

| Command | Description |
| --- | --- |
| `logout --account <email\|key>` | Remove one account. If it was active, the active account repoints to a remaining one (or clears `auth.json` if none remain). |
| `logout --all` | Remove every enrolled account and clear `auth.json`. |

Bare `logout` prints a usage error listing the enrolled accounts.

### Selectors

`--account` / `use` / `enable` / `disable` accept, in priority order: an exact
key, a case-insensitive email (must be unique), or an unambiguous key prefix.
Ambiguous or unknown selectors produce an error listing the candidates.

## Selection & fallback

`fetchCodexBackend` (the single backend chokepoint) walks the candidate list the
strategy returns:

1. Resolve the candidate's auth, refreshing if the token is within 60 s of expiry.
2. `POST`/`GET` upstream.
3. On `401`, force-refresh that account once and retry.
4. If the status is **fallback-worthy** and this isn't the last candidate, move
   to the next account. Fallback-worthy = `401` (post-refresh), `403`, `408`,
   `409`, `425`, `429`, `5xx`, or a network throw.
5. Request-level statuses (`400`, `404`, `413`, `422`, …) are returned as-is —
   they'd fail identically on any account.
6. The **last** candidate's response is always returned, so error messages and
   exit codes are exactly what the single-account CLI produced.

This is safe to retry across accounts because the request body is a string and
the streaming response body isn't consumed until after a candidate is chosen.

Concurrent requests under `serve` that pick the same account share a single
in-flight token refresh (no duplicate refresh storms).

## Seeing which account served a request

Three ways, increasing in directness:

1. **`accounts list`** shows each account's `last used:` timestamp. After a call,
   the account whose timestamp just advanced is the one that served it. Repeat a
   few prompts to watch selection spread across accounts; `accounts disable <key>`
   one and confirm only the other advances.
2. **`VICOOP_CODEX_LOG_ACCOUNT=1`** logs the chosen account (and any fallback
   hops) to stderr for every backend call — works for `prompt`, `call`, `serve`,
   and A2A. Off by default; no effect on normal output.
   ```bash
   VICOOP_CODEX_LOG_ACCOUNT=1 vicoop-codex prompt -m <model> "hi"
   # stderr: [account] using bob@home.com [pro-9]
   #         (on failover: [account] alice@corp.com [team-1] → HTTP 429; falling back to next account)
   ```
3. **`prompt --json`** includes an `account` field: `{ "account": { "key": "...", "email": "..." } }`.

## Remaining usage

Each ChatGPT-subscription account exposes its Codex usage/rate-limit status at
`GET …/backend-api/wham/usage` — the account-wide **5-hour** (primary) and
**weekly** (secondary) rolling windows, plus credits. This is a read-only call
that does **not** consume quota, so it's safe to poll on demand.

```bash
vicoop-codex accounts usage              # all accounts
vicoop-codex accounts usage bob@home.com # one account
vicoop-codex accounts usage --json       # machine-readable (+ raw upstream payload)
```

Each window reports `used_percent`, `remaining_percent` (= 100 − used), the
window length (`limit_window_seconds`), and `reset_after_seconds` / `reset_at`.
The wire schema mirrors codex's `RateLimitStatusPayload`; parsing is defensive
and the raw payload is preserved under `raw` in `--json`.

**While serving**, the same data is exposed over HTTP:

```
GET /usage      (alias: GET /v1/usage)
→ { "accounts": [ { key, email, plan_type, limit_reached, primary, secondary, credits, error } ] }
```

A per-account lookup failure (auth/network) is captured in that account's
`error` field rather than failing the whole response.

The endpoint URL can be overridden with `VICOOP_CODEX_USAGE_URL` (debugging /
backend changes).

## Strategy configuration

Resolution order for the active strategy:

1. `VICOOP_CODEX_ACCOUNT_STRATEGY` environment variable (highest priority —
   handy for `serve` deployments).
2. The persisted `strategy` in `state.json` (set via `accounts strategy <name>`).
3. Default: `random`.

An unknown strategy name falls back to `random` with a stderr warning, so a typo
never breaks calls.

Built-in strategies:

| name | behavior |
| --- | --- |
| `random` (default) | uniform shuffle of the enabled accounts |
| `burn-rate` | "use-it-or-lose-it" — prefer the account whose remaining quota would otherwise reset soonest (see below) |

## The `burn-rate` strategy

```bash
vicoop-codex accounts strategy burn-rate
```

Prioritizes the account with the highest **required burn rate** on the short
(5h) window:

```
urgency = remaining_percent / seconds_until_reset    # remaining ÷ time-to-reset
```

A high score means lots of quota is left **and** the window resets soon — i.e.
that quota will be wasted unless spent now, so it's drained first. Concretely
(both 80% remaining): an account resetting in 30 min outranks one resetting in
4 h; and at equal reset time, the account with more remaining outranks the one
with less. It's an amount-weighted earliest-deadline-first heuristic that
minimizes wasted quota across accounts.

Details:
- **Usability gate**: accounts that are rate-limited (`limit_reached`) or have a
  fully-consumed primary **or** secondary (weekly) window sort last — usable only
  as fallback.
- **Unknown usage**: if a usage lookup fails, that account sorts in the middle
  (after scored accounts, before exhausted ones) with a random tiebreak, so it
  isn't starved.
- **Reset floor**: time-to-reset is floored at 60s to avoid divide-by-zero and
  unbounded scores; a just-reset window naturally drops in priority as its
  remaining refills and its reset moves far out again.
- **Freshness**: usage is fetched (via `/wham/usage`) only for usage-aware
  strategies and cached per account with a TTL (default 60s, override with
  `VICOOP_CODEX_USAGE_TTL_SECONDS`). The first call after the TTL expires does
  one usage GET per account (in parallel) before selecting; within the TTL it's
  free. Absolute `reset_at` timestamps are cached, so a slightly stale cache
  still scores correctly.

## Extending selection

Selection is the designed extension seam. To add a policy
(e.g. round-robin, least-recently-used, weighted, quota/health-aware):

1. Implement `AccountSelector` (`src/auth/selection/types.ts`):

   ```ts
   export class RoundRobinSelector implements AccountSelector {
     readonly name = "round-robin";
     order(accounts: SelectableAccount[], ctx?: SelectionContext): SelectableAccount[] {
       // return the full candidate list head→tail; head is the primary pick
     }
   }
   ```

   `SelectableAccount` carries `key`, `email`, and `meta` (including `lastUsedAt`
   / `lastError` / `lastErrorAt`) — enough for time- or health-aware policies.
   `SelectionContext.reason` carries a request hint (`"POST /responses"`) for
   future request-aware routing.

2. Register it in `src/auth/selection/registry.ts`:

   ```ts
   registerSelector("round-robin", () => new RoundRobinSelector());
   ```

No changes to the manager, backend loop, or commands are needed — the registry
and `getStrategyName()` wire it up, and `accounts strategy round-robin` selects it.
