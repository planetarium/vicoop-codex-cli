import { loadAuthCandidates, type ActiveAuth } from "../auth/manager.js";

const CHATGPT_CODEX_API_BASE_URL = "https://chatgpt.com/backend-api/codex";

export const CODEX_BACKEND_CLIENT_VERSION = "0.133.0";

export type CodexBackendPath = "/responses" | "/models";

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
): Headers {
  const headers = new Headers(extra);
  headers.set("Authorization", `Bearer ${auth.accessToken}`);
  headers.set("OAI-Product-Sku", "codex");
  headers.set("User-Agent", "vicoop-codex-cli/0.1.0");
  headers.set("originator", "codex_cli_rs");
  if (auth.accountId) headers.set("ChatGPT-Account-ID", auth.accountId);
  return headers;
}

async function fetchWithAuth(
  auth: ActiveAuth,
  path: CodexBackendPath,
  init: RequestInit = {},
  query?: URLSearchParams,
): Promise<Response> {
  return fetch(buildCodexBackendUrl(path, query), {
    ...init,
    headers: buildCodexHeaders(auth, init.headers),
  });
}

/**
 * Whether a non-OK status warrants trying a *different* account. These are
 * conditions that can differ between accounts (auth/permission/quota/transient
 * backend). Statuses that reflect the request itself (400/404/413/422 …) are
 * the same for every account, so they are returned as-is without fallback.
 */
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
): Promise<Response> {
  const candidates = await loadAuthCandidates({
    reason: `${init.method ?? "GET"} ${path}`,
  });

  let lastError: unknown;
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const isLast = i === candidates.length - 1;

    let auth: ActiveAuth;
    try {
      auth = await candidate.resolve();
    } catch (err) {
      lastError = err;
      await candidate.reportError(err).catch(() => undefined);
      if (isLast) break;
      continue;
    }

    let res: Response;
    try {
      res = await fetchWithAuth(auth, path, init, query);
    } catch (err) {
      lastError = err;
      await candidate.reportError(err).catch(() => undefined);
      if (isLast) break;
      continue;
    }

    if (res.status === 401) {
      await discardBody(res);
      try {
        auth = await candidate.refresh();
        res = await fetchWithAuth(auth, path, init, query);
      } catch (err) {
        lastError = err;
        await candidate.reportError(err).catch(() => undefined);
        if (isLast) break;
        continue;
      }
    }

    if (!isLast && isFallbackWorthyStatus(res.status)) {
      await discardBody(res);
      lastError = new Error(`ChatGPT backend returned HTTP ${res.status}`);
      await candidate.reportError(lastError).catch(() => undefined);
      continue;
    }

    if (res.ok) await candidate.reportSuccess().catch(() => undefined);
    return res;
  }

  // Reached only when the last candidate threw (network / refresh failure).
  if (lastError) throw lastError;
  throw new Error("no accounts available to call the ChatGPT backend");
}
