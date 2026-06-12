import {
  resolveAuthForKey,
  refreshAuthForKey,
  type ActiveAuth,
} from "../auth/manager.js";
import { readAccountRecords } from "../auth/account-store.js";
import { buildCodexHeaders } from "./backend.js";

/**
 * Per-account remaining-usage lookup.
 *
 * ChatGPT-subscription accounts expose their Codex usage/rate-limit status at
 * `…/backend-api/wham/usage` (GET) — the same account-wide 5h + weekly windows
 * the IDE/CLI surface. Unlike `/responses`, this is a read-only call that does
 * NOT consume quota, so it's safe to poll on demand. Wire schema mirrors
 * codex `RateLimitStatusPayload` (plan_type, rate_limit.{primary,secondary}_window
 * with used_percent / limit_window_seconds / reset_after_seconds / reset_at,
 * and credits).
 */

const DEFAULT_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

/** Endpoint, overridable for debugging / backend changes. */
export function usageUrl(): string {
  const override = process.env.VICOOP_CODEX_USAGE_URL?.trim();
  return override && override.length > 0 ? override : DEFAULT_USAGE_URL;
}

export interface RateLimitWindow {
  /** Percent of the window's allowance consumed (0–100). */
  used_percent: number;
  /** Convenience: 100 − used_percent, clamped to 0–100. */
  remaining_percent: number;
  /** Window length in seconds (e.g. 18000 = 5h, 604800 = weekly). */
  limit_window_seconds?: number;
  /** Seconds until this window resets. */
  reset_after_seconds?: number;
  /** Epoch seconds at which this window resets. */
  reset_at?: number;
}

export interface UsageSnapshot {
  plan_type?: string;
  allowed?: boolean;
  limit_reached?: boolean;
  /** Short rolling window (typically 5h). */
  primary?: RateLimitWindow;
  /** Long rolling window (typically weekly). */
  secondary?: RateLimitWindow;
  credits?: { has_credits?: boolean; unlimited?: boolean; balance?: string | null };
  /** The full upstream payload, untouched (for --json / forward-compat). */
  raw: unknown;
}

export class UsageError extends Error {
  status: number;
  detail?: string;
  constructor(status: number, message: string, detail?: string) {
    super(message);
    this.name = "UsageError";
    this.status = status;
    this.detail = detail;
  }
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function bool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function parseWindow(w: unknown): RateLimitWindow | undefined {
  if (!w || typeof w !== "object") return undefined;
  const o = w as Record<string, unknown>;
  const used = num(o.used_percent);
  if (
    used === undefined &&
    num(o.reset_after_seconds) === undefined &&
    num(o.reset_at) === undefined
  ) {
    return undefined;
  }
  const usedPct = used ?? 0;
  return {
    used_percent: usedPct,
    remaining_percent: Math.max(0, Math.min(100, 100 - usedPct)),
    limit_window_seconds: num(o.limit_window_seconds),
    reset_after_seconds: num(o.reset_after_seconds),
    reset_at: num(o.reset_at),
  };
}

/** Normalize the upstream payload into {@link UsageSnapshot} (defensive). */
export function normalizeUsage(raw: unknown): UsageSnapshot {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const rl = (o.rate_limit && typeof o.rate_limit === "object" ? o.rate_limit : {}) as Record<
    string,
    unknown
  >;
  const credits =
    o.credits && typeof o.credits === "object"
      ? (o.credits as Record<string, unknown>)
      : undefined;
  return {
    plan_type: str(o.plan_type),
    allowed: bool(rl.allowed),
    limit_reached: bool(rl.limit_reached),
    primary: parseWindow(rl.primary_window),
    secondary: parseWindow(rl.secondary_window),
    credits: credits
      ? {
          has_credits: bool(credits.has_credits),
          unlimited: bool(credits.unlimited),
          balance: str(credits.balance) ?? null,
        }
      : undefined,
    raw,
  };
}

async function getUsage(auth: ActiveAuth): Promise<Response> {
  return fetch(usageUrl(), {
    method: "GET",
    headers: buildCodexHeaders(auth, { Accept: "application/json" }),
  });
}

/** Fetch and normalize usage for a single account, refreshing once on a 401. */
export async function fetchUsageForKey(key: string): Promise<UsageSnapshot> {
  let auth = await resolveAuthForKey(key);
  let res = await getUsage(auth);
  if (res.status === 401) {
    await res.body?.cancel().catch(() => undefined);
    auth = await refreshAuthForKey(key);
    res = await getUsage(auth);
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 1000);
    throw new UsageError(res.status, `usage endpoint returned HTTP ${res.status}`, detail);
  }
  let raw: unknown;
  try {
    raw = await res.json();
  } catch (err) {
    throw new UsageError(
      res.status,
      `usage endpoint returned a non-JSON body: ${(err as Error).message ?? String(err)}`,
    );
  }
  return normalizeUsage(raw);
}

export interface AccountUsage {
  key: string;
  email?: string;
  usage?: UsageSnapshot;
  /** Set when this account's lookup failed; the others still resolve. */
  error?: string;
}

/** Query usage for every enrolled account in parallel; per-account errors are captured, not thrown. */
export async function fetchAllAccountUsage(): Promise<AccountUsage[]> {
  const records = await readAccountRecords();
  return Promise.all(
    records.map(async (r): Promise<AccountUsage> => {
      try {
        return { key: r.meta.key, email: r.meta.email, usage: await fetchUsageForKey(r.meta.key) };
      } catch (err) {
        return {
          key: r.meta.key,
          email: r.meta.email,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
}
