import { forceRefresh, loadActiveAuth, type ActiveAuth } from "../auth/manager.js";

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

function buildHeaders(auth: ActiveAuth, extra?: RequestInit["headers"]): Headers {
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
    headers: buildHeaders(auth, init.headers),
  });
}

export async function fetchCodexBackend(
  path: CodexBackendPath,
  init: RequestInit = {},
  query?: URLSearchParams,
): Promise<Response> {
  let auth = await loadActiveAuth();
  let res = await fetchWithAuth(auth, path, init, query);
  if (res.status === 401) {
    await res.body?.cancel().catch(() => undefined);
    auth = await forceRefresh();
    res = await fetchWithAuth(auth, path, init, query);
  }
  return res;
}
