import { forceRefresh, loadActiveAuth, type ActiveAuth } from "../auth/manager.js";

export const CODEX_BACKEND_CLIENT_VERSION = "0.133.0";

const CHATGPT_CODEX_MODELS_URL = "https://chatgpt.com/backend-api/codex/models";

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

function buildHeaders(auth: ActiveAuth): Headers {
  const headers = new Headers({
    Authorization: `Bearer ${auth.accessToken}`,
    Accept: "application/json",
    "OAI-Product-Sku": "codex",
    "User-Agent": "vicoop-codex-cli/0.1.0",
    originator: "codex_cli_rs",
  });
  if (auth.accountId) headers.set("ChatGPT-Account-ID", auth.accountId);
  return headers;
}

async function getModels(auth: ActiveAuth, clientVersion: string): Promise<Response> {
  const url = new URL(CHATGPT_CODEX_MODELS_URL);
  url.searchParams.set("client_version", clientVersion);
  return fetch(url, {
    method: "GET",
    headers: buildHeaders(auth),
  });
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

export async function fetchCodexModels(
  clientVersion = CODEX_BACKEND_CLIENT_VERSION,
): Promise<CodexModelsResult> {
  let auth = await loadActiveAuth();
  let res = await getModels(auth, clientVersion);
  if (res.status === 401) {
    await res.body?.cancel().catch(() => undefined);
    auth = await forceRefresh();
    res = await getModels(auth, clientVersion);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `ChatGPT Codex models endpoint returned HTTP ${res.status}: ${detail.slice(0, 1000)}`,
    );
  }

  return readModels(res, clientVersion);
}
