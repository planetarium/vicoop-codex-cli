import {
  CODEX_BACKEND_CLIENT_VERSION,
  fetchCodexBackend,
} from "./backend.js";

export { CODEX_BACKEND_CLIENT_VERSION };

export interface CodexModel {
  id: string;
  name?: string;
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
  service_tiers?: unknown;
}

function normalizeModel(raw: RawCodexModel): CodexModel | null {
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

const DEFAULT_MODEL_TTL_MS = 5 * 60 * 1000;

let cachedDefaultModel: { id: string; expiresAt: number } | null = null;

/**
 * Resolve the default model dynamically by querying the supported models and
 * returning the first one. The server's default occasionally disappears, so we
 * avoid hardcoding it. Cached for {@link DEFAULT_MODEL_TTL_MS} so long-running
 * processes (e.g. `serve`) pick up changes without restarting while still
 * avoiding a `/models` round trip on every request. Throws if no models are
 * available rather than falling back to a stale constant.
 */
export async function resolveDefaultModel(): Promise<string> {
  const now = Date.now();
  if (cachedDefaultModel && cachedDefaultModel.expiresAt > now) {
    return cachedDefaultModel.id;
  }
  const { models } = await fetchCodexModels();
  const first = models[0]?.id;
  if (!first) {
    throw new Error(
      "ChatGPT Codex models endpoint returned no usable models; cannot resolve a default model",
    );
  }
  cachedDefaultModel = { id: first, expiresAt: now + DEFAULT_MODEL_TTL_MS };
  return first;
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
