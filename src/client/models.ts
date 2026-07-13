import {
  CODEX_BACKEND_CLIENT_VERSION,
  fetchCodexBackend,
} from "./backend.js";

export { CODEX_BACKEND_CLIENT_VERSION };

export interface CodexModel {
  id: string;
  name?: string;
  // Effective context window in tokens, as reported by the ChatGPT Codex
  // backend. Surfaced so downstream consumers (e.g. the vicoop-bridge
  // openai-compat/v1 `contextWindow` advertise) can read a model's window
  // without a hardcoded table. Omitted when the backend doesn't report a
  // positive integer.
  context_window?: number;
  service_tiers?: Array<{
    id?: string;
    name?: string;
    description?: string;
  }>;
}

export interface CodexModelsResult {
  client_version: string;
  etag?: string;
  models: CodexModel[];
}

interface RawCodexModel {
  id?: unknown;
  slug?: unknown;
  name?: unknown;
  context_window?: unknown;
  service_tiers?: unknown;
}

// Exported for unit tests.
export function normalizeModel(raw: RawCodexModel): CodexModel | null {
  const id =
    typeof raw.slug === "string"
      ? raw.slug
      : typeof raw.id === "string"
        ? raw.id
        : typeof raw.name === "string"
          ? raw.name
          : undefined;
  if (!id) return null;

  const out: CodexModel = { id };
  if (typeof raw.name === "string" && raw.name !== id) out.name = raw.name;
  // Positive-integer guard so a missing / zero / negative / fractional value
  // never surfaces as a bogus window.
  if (
    typeof raw.context_window === "number" &&
    Number.isInteger(raw.context_window) &&
    raw.context_window > 0
  ) {
    out.context_window = raw.context_window;
  }
  if (Array.isArray(raw.service_tiers)) {
    out.service_tiers = raw.service_tiers
      .filter((tier): tier is Record<string, unknown> => tier && typeof tier === "object")
      .map((tier) => ({
        id: typeof tier.id === "string" ? tier.id : undefined,
        name: typeof tier.name === "string" ? tier.name : undefined,
        description:
          typeof tier.description === "string" ? tier.description : undefined,
      }));
  }
  return out;
}

async function readModels(res: Response, clientVersion: string): Promise<CodexModelsResult> {
  const parsed = (await res.json()) as { models?: RawCodexModel[] };
  const models = Array.isArray(parsed.models)
    ? parsed.models.map(normalizeModel).filter((m): m is CodexModel => m !== null)
    : [];
  return {
    client_version: clientVersion,
    etag: res.headers.get("etag") ?? undefined,
    models,
  };
}

export async function fetchCodexModels(
  clientVersion = CODEX_BACKEND_CLIENT_VERSION,
): Promise<CodexModelsResult> {
  const query = new URLSearchParams({ client_version: clientVersion });
  const res = await fetchCodexBackend(
    "/models",
    {
      method: "GET",
      headers: { Accept: "application/json" },
    },
    query,
  );

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `ChatGPT Codex models endpoint returned HTTP ${res.status}: ${detail.slice(0, 1000)}`,
    );
  }

  return readModels(res, clientVersion);
}

/**
 * Best-effort fetch of the available model ids, for use in error messages when
 * a caller omits the (now-required) model. Never throws — returns null on any
 * failure (not signed in, offline, backend error) so the error path is robust.
 */
export async function tryListModelIds(): Promise<string[] | null> {
  try {
    const result = await fetchCodexModels();
    const ids = result.models.map((m) => m.id).filter((id) => id.length > 0);
    return ids.length > 0 ? ids : null;
  } catch {
    return null;
  }
}
