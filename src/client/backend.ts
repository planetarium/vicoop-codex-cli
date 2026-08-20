import { loadAuthCandidates, type ActiveAuth } from "../auth/manager.js";

const CHATGPT_CODEX_API_BASE_URL = "https://chatgpt.com/backend-api/codex";

// Bumped 0.133.0 -> 0.145.0: the ChatGPT Codex backend gates newer model slugs
// behind a minimum client_version. 0.133.0/0.140.0 only expose up to gpt-5.5;
// 0.145.0 is the minimal version at which the gpt-5.6 family (gpt-5.6-sol,
// gpt-5.6-terra, gpt-5.6-luna) becomes available from GET /models.
export const CODEX_BACKEND_CLIENT_VERSION = "0.145.0";

export type CodexBackendPath = "/responses" | "/models";

/**
 * Legacy User-Agent — the identity every release up to 0.6.3 presented, and the
 * cache-safe one. Presenting the official-CLI signature instead (0.6.4+, see
 * `codexCliUserAgent`) makes the backend treat us as a modern Codex client and
 * demonstrably collapses prompt-cache hit rates: production hit *ratio* fell
 * 78–93% → 30–51% across ALL models right at the 0.6.4 rollout, and a
 * controlled same-day A/B on gpt-5.6-sol (v0.6.3 vs v0.8.2, interleaved,
 * Fisher p=0.032) measured 27.0% vs 5.6% — a ~5x drop attributable to the UA
 * alone (planetarium/vicoop-codex-cli#48). Kept verbatim (stale version and
 * all) because this exact string is the empirically validated identity.
 */
export const LEGACY_USER_AGENT = "vicoop-codex-cli/0.1.0";

/**
 * Whether a model slug requires the official Codex CLI User-Agent signature.
 *
 * The backend gates its client identity on an AND of `originator` + `User-Agent`.
 * Most model slugs (gpt-5.5, gpt-5.6-sol, gpt-5.6-terra) pass on the originator
 * alone, but the gpt-5.6-luna slug additionally routes to an internal engine
 * that is only exposed when the `User-Agent` carries the official Codex CLI
 * signature `codex_cli_rs/<version>` — otherwise the slug resolves to a missing
 * engine and the backend replies 404 "Model not found gpt-5.6-luna" (confirmed
 * empirically: flipping only the UA prefix flips 404 -> 200 with the same token
 * and originator; see openai/codex#31967). `startsWith` so luna point releases
 * (e.g. a future gpt-5.6-luna-mini) stay covered.
 */
export function modelRequiresCodexCliUa(model?: string): boolean {
  return typeof model === "string" && model.startsWith("gpt-5.6-luna");
}

/**
 * The official-CLI User-Agent signature. The gate only inspects the
 * `codex_cli_rs/<version>` prefix, so we keep an honest vicoop attribution in
 * the suffix. The version is pinned to CODEX_BACKEND_CLIENT_VERSION so it stays
 * in lockstep with the model catalog our client_version already advertises.
 */
export function codexCliUserAgent(): string {
  return `codex_cli_rs/${CODEX_BACKEND_CLIENT_VERSION} (${process.platform}; ${process.arch}) vicoop-codex-cli/0.1.0`;
}

/**
 * User-Agent presented to the ChatGPT Codex backend for a request targeting
 * `model` (undefined for model-less calls: GET /models, the usage endpoint).
 *
 * Conditional by design: the `codex_cli_rs` signature is required ONLY by
 * gpt-5.6-luna (`modelRequiresCodexCliUa`), while presenting it on everything
 * else costs ~5x in prompt-cache hits (#48, measurements on
 * `LEGACY_USER_AGENT`). So luna requests carry the official signature and every
 * other call keeps the legacy, cache-safe identity — luna access and cache
 * behavior are both preserved. The `/models` catalog itself is unaffected:
 * model availability there is gated by the `client_version` query param, and
 * the full 5.6 family lists under the legacy UA (verified on v0.6.3).
 */
export function codexUserAgent(model?: string): string {
  return modelRequiresCodexCliUa(model) ? codexCliUserAgent() : LEGACY_USER_AGENT;
}

function buildCodexBackendUrl(path: CodexBackendPath, query?: URLSearchParams): string {
  const url = new URL(`${CHATGPT_CODEX_API_BASE_URL}${path}`);
  if (query) {
    for (const [key, value] of query) url.searchParams.set(key, value);
  }
  return url.toString();
}

/**
 * Standard auth + identification headers for ChatGPT Codex backend calls.
 * Exported so sibling clients (e.g. the usage endpoint, which lives at a
 * different base path) can authenticate identically.
 */
export function buildCodexHeaders(
  auth: ActiveAuth,
  extra?: RequestInit["headers"],
  model?: string,
): Headers {
  const headers = new Headers(extra);
  headers.set("Authorization", `Bearer ${auth.accessToken}`);
  headers.set("OAI-Product-Sku", "codex");
  headers.set("User-Agent", codexUserAgent(model));
  headers.set("originator", "codex_cli_rs");
  if (auth.accountId) headers.set("ChatGPT-Account-ID", auth.accountId);
  return headers;
}

async function fetchWithAuth(
  auth: ActiveAuth,
  path: CodexBackendPath,
  init: RequestInit = {},
  query?: URLSearchParams,
  model?: string,
): Promise<Response> {
  const reqInit: RequestInit = {
    ...init,
    headers: buildCodexHeaders(auth, init.headers, model),
  };
  // Only the long-lived streaming `/responses` call needs its inter-chunk idle
  // timeout disabled (a reasoning model can stay silent for minutes before its
  // first byte). Scope it to that path so short calls like `/models` keep a
  // finite body timeout and can't hang forever after headers. A genuinely stuck
  // `/responses` is bounded instead by the per-request absolute deadline
  // (`responses.ts#withDeadline`).
  //
  // The compiled release binaries run on Bun, whose native fetch has a fixed
  // ~300s idle timeout (throws "The operation timed out."); `timeout: false`
  // disables it. This is a Bun extension to the DOM `RequestInit` type (Node's
  // fetch ignores the field), hence the cast.
  if (path === "/responses") {
    (reqInit as { timeout?: boolean }).timeout = false;
  }
  return fetch(buildCodexBackendUrl(path, query), reqInit);
}

/**
 * Whether a non-OK status warrants trying a *different* account. These are
 * conditions that can differ between accounts (auth/permission/quota/transient
 * backend). Statuses that reflect the request itself (400/404/413/422 …) are
 * the same for every account, so they are returned as-is without fallback.
 */
/** Identifies which enrolled account a call ultimately used. */
export interface UsedAccountInfo {
  key: string;
  email?: string;
}

export interface FetchCodexOptions {
  /** Invoked with the account whose response is returned (after fallback resolves). */
  onAccount?: (info: UsedAccountInfo) => void;
  /**
   * Model slug the request targets, when known. Drives User-Agent selection
   * (`codexUserAgent(model)`): gpt-5.6-luna gets the official `codex_cli_rs`
   * signature it requires; everything else keeps the legacy, cache-safe UA
   * (#48). Omit for model-less calls (GET /models, usage).
   */
  model?: string;
}

function accountLogEnabled(): boolean {
  const v = process.env.VICOOP_CODEX_LOG_ACCOUNT ?? process.env.VICOOP_CODEX_DEBUG;
  return v === "1" || v === "true";
}

function accountLabel(info: UsedAccountInfo): string {
  return `${info.email ?? "(unknown email)"} [${info.key}]`;
}

export function isFallbackWorthyStatus(status: number): boolean {
  return (
    status === 401 ||
    status === 403 ||
    status === 408 ||
    status === 409 ||
    status === 425 ||
    status === 429 ||
    status >= 500
  );
}

async function discardBody(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => undefined);
}

/**
 * Call the ChatGPT Codex backend, selecting an account via the active strategy
 * and falling back to other accounts on failure.
 *
 * The walk over candidates is safe to retry because the request `body` is a
 * string (re-sendable) and the SSE response body is not consumed until after
 * this function returns — so fallback is decided purely on the initial HTTP
 * status, before any streaming begins.
 *
 * For each candidate, in order:
 *   1. resolve auth (refresh if near expiry); on failure, try the next.
 *   2. fetch; on a network throw, try the next.
 *   3. on 401, force-refresh once and retry (preserves single-account behavior).
 *   4. if the status is fallback-worthy and this isn't the last candidate,
 *      discard the body and try the next.
 *   5. otherwise return the response. The LAST candidate's response is always
 *      returned as-is (even an error), so existing error formatting is unchanged.
 *
 * With a single enrolled account this collapses to the original
 * resolve → fetch → 401-refresh-retry → return path.
 */
export async function fetchCodexBackend(
  path: CodexBackendPath,
  init: RequestInit = {},
  query?: URLSearchParams,
  opts?: FetchCodexOptions,
): Promise<Response> {
  const candidates = await loadAuthCandidates({
    reason: `${init.method ?? "GET"} ${path}`,
  });
  const logging = accountLogEnabled();

  let lastError: unknown;
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const info: UsedAccountInfo = { key: candidate.key, email: candidate.email };
    const isLast = i === candidates.length - 1;

    let auth: ActiveAuth;
    try {
      auth = await candidate.resolve();
    } catch (err) {
      lastError = err;
      if (logging) {
        process.stderr.write(
          `[account] ${accountLabel(info)} unavailable: ${(err as Error).message ?? err}\n`,
        );
      }
      await candidate.reportError(err).catch(() => undefined);
      if (isLast) break;
      continue;
    }

    let res: Response;
    try {
      res = await fetchWithAuth(auth, path, init, query, opts?.model);
    } catch (err) {
      lastError = err;
      if (logging) {
        process.stderr.write(
          `[account] ${accountLabel(info)} network error: ${(err as Error).message ?? err}; ${isLast ? "no more accounts" : "falling back"}\n`,
        );
      }
      await candidate.reportError(err).catch(() => undefined);
      if (isLast) break;
      continue;
    }

    if (res.status === 401) {
      await discardBody(res);
      try {
        auth = await candidate.refresh();
        res = await fetchWithAuth(auth, path, init, query, opts?.model);
      } catch (err) {
        lastError = err;
        if (logging) {
          process.stderr.write(
            `[account] ${accountLabel(info)} refresh failed: ${(err as Error).message ?? err}; ${isLast ? "no more accounts" : "falling back"}\n`,
          );
        }
        await candidate.reportError(err).catch(() => undefined);
        if (isLast) break;
        continue;
      }
    }

    if (!isLast && isFallbackWorthyStatus(res.status)) {
      await discardBody(res);
      if (logging) {
        process.stderr.write(
          `[account] ${accountLabel(info)} → HTTP ${res.status}; falling back to next account\n`,
        );
      }
      lastError = new Error(`ChatGPT backend returned HTTP ${res.status}`);
      await candidate.reportError(lastError).catch(() => undefined);
      continue;
    }

    opts?.onAccount?.(info);
    if (logging) {
      process.stderr.write(
        `[account] using ${accountLabel(info)}${res.ok ? "" : ` (HTTP ${res.status})`}\n`,
      );
    }
    if (res.ok) await candidate.reportSuccess().catch(() => undefined);
    return res;
  }

  // Reached only when the last candidate threw (network / refresh failure).
  if (lastError) throw lastError;
  throw new Error("no accounts available to call the ChatGPT backend");
}
