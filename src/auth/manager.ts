import { isExpired, extractAccountId } from "./jwt.js";
import { refreshTokens } from "./oauth.js";
import type { AuthFile } from "./store.js";
import {
  getActiveKey,
  getStrategyName,
  markError,
  markUsed,
  readAccount,
  readAccountRecords,
  writeAccountAuth,
  writeUsageCache,
  type AccountRecord,
  type UsageCacheEntry,
} from "./account-store.js";
import {
  getSelector,
  type SelectableAccount,
  type SelectionContext,
  type UsageForSelection,
} from "./selection/index.js";
import type { UsageSnapshot } from "../client/usage.js";

export class NotAuthenticatedError extends Error {
  constructor() {
    super("Not signed in. Run `vicoop-codex login` first.");
    this.name = "NotAuthenticatedError";
  }
}

export interface ActiveAuth {
  accessToken: string;
  accountId?: string;
  /** Key of the enrolled account this auth came from (for logging / metadata). */
  accountKey?: string;
}

/**
 * One account the backend loop can try. The selector decides the order of
 * these; the loop walks them, calling `resolve()` (and `refresh()` after a 401)
 * and reporting the outcome so future selection can be smarter.
 */
export interface AccountCandidate {
  key: string;
  email?: string;
  /** Ready-to-use auth, refreshing+persisting first if the token is near expiry. */
  resolve(): Promise<ActiveAuth>;
  /** Force a token refresh for this account (used after a 401). */
  refresh(): Promise<ActiveAuth>;
  /** Record that a call on this account succeeded. */
  reportSuccess(): Promise<void>;
  /** Record that a call on this account failed (selection metadata). */
  reportError(err: unknown): Promise<void>;
}

const SKEW_SECONDS = 60;

// Dedupe concurrent refreshes of the same account (e.g. parallel `serve`
// requests that both picked it) — mirrors the resolve-once pattern in
// client/default-model.ts. Keyed by account key.
const refreshInFlight = new Map<string, Promise<AuthFile>>();

function mergeRefreshed(
  prev: AuthFile,
  refreshed: { idToken?: string; accessToken: string; refreshToken: string },
): AuthFile {
  const idToken = refreshed.idToken ?? prev.tokens.id_token;
  const accountId = refreshed.idToken
    ? extractAccountId(refreshed.idToken) ?? prev.tokens.account_id
    : prev.tokens.account_id;
  return {
    ...prev,
    tokens: {
      id_token: idToken,
      access_token: refreshed.accessToken,
      refresh_token: refreshed.refreshToken,
      account_id: accountId,
    },
    last_refresh: new Date().toISOString(),
  };
}

/**
 * Refresh one account from its latest persisted refresh token and write the
 * new tokens back. Concurrent callers for the same key share one in-flight
 * request. Always reads the current record so it uses the freshest token.
 */
function refreshAccountByKey(key: string): Promise<AuthFile> {
  let pending = refreshInFlight.get(key);
  if (!pending) {
    pending = (async () => {
      const current = await readAccount(key);
      if (!current) throw new NotAuthenticatedError();
      const refreshed = await refreshTokens(current.auth.tokens.refresh_token);
      const next = mergeRefreshed(current.auth, refreshed);
      await writeAccountAuth(key, next);
      return next;
    })();
    refreshInFlight.set(key, pending);
    void pending.finally(() => {
      if (refreshInFlight.get(key) === pending) refreshInFlight.delete(key);
    });
  }
  return pending;
}

function toActiveAuth(auth: AuthFile, key: string): ActiveAuth {
  return {
    accessToken: auth.tokens.access_token,
    accountId: auth.tokens.account_id,
    accountKey: key,
  };
}

function makeCandidate(rec: AccountRecord): AccountCandidate {
  const key = rec.meta.key;
  return {
    key,
    email: rec.meta.email,
    resolve: async () => {
      if (isExpired(rec.auth.tokens.access_token, SKEW_SECONDS)) {
        return toActiveAuth(await refreshAccountByKey(key), key);
      }
      return toActiveAuth(rec.auth, key);
    },
    refresh: async () => toActiveAuth(await refreshAccountByKey(key), key),
    reportSuccess: () => markUsed(key),
    reportError: (err: unknown) => markError(key, errorMessage(err)),
  };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function toSelectable(rec: AccountRecord): SelectableAccount {
  return { key: rec.meta.key, email: rec.meta.email, meta: rec.meta };
}

const USAGE_TTL_MS_DEFAULT = 60_000;

function usageTtlMs(): number {
  const raw = Number(process.env.VICOOP_CODEX_USAGE_TTL_SECONDS);
  return Number.isFinite(raw) && raw >= 0 ? raw * 1000 : USAGE_TTL_MS_DEFAULT;
}

function isFreshCache(entry: UsageCacheEntry | undefined, ttlMs: number): boolean {
  if (!entry) return false;
  const t = new Date(entry.fetchedAt).getTime();
  return Number.isFinite(t) && Date.now() - t < ttlMs;
}

function cacheToUsage(c: UsageCacheEntry): UsageForSelection {
  const ms = new Date(c.fetchedAt).getTime();
  const fetchedAtEpoch = Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
  const primary =
    c.primaryRemaining !== undefined ||
    c.primaryResetAt !== undefined ||
    c.primaryResetAfter !== undefined
      ? {
          remainingPercent: c.primaryRemaining,
          resetAtEpoch: c.primaryResetAt,
          resetAfterSeconds: c.primaryResetAfter,
        }
      : undefined;
  const secondary =
    c.secondaryRemaining !== undefined ||
    c.secondaryResetAt !== undefined ||
    c.secondaryResetAfter !== undefined
      ? {
          remainingPercent: c.secondaryRemaining,
          resetAtEpoch: c.secondaryResetAt,
          resetAfterSeconds: c.secondaryResetAfter,
        }
      : undefined;
  return { planType: c.planType, limitReached: c.limitReached, fetchedAtEpoch, primary, secondary };
}

function snapshotToCache(snap: UsageSnapshot, fetchedAt: string): UsageCacheEntry {
  return {
    fetchedAt,
    planType: snap.plan_type,
    limitReached: snap.limit_reached,
    primaryRemaining: snap.primary?.remaining_percent,
    primaryResetAt: snap.primary?.reset_at,
    primaryResetAfter: snap.primary?.reset_after_seconds,
    secondaryRemaining: snap.secondary?.remaining_percent,
    secondaryResetAt: snap.secondary?.reset_at,
    secondaryResetAfter: snap.secondary?.reset_after_seconds,
  };
}

/**
 * Build selectables with usage attached, for usage-aware strategies. Uses each
 * account's TTL cache; refreshes stale/missing entries in parallel via a live
 * usage lookup (dynamic import avoids a manager↔usage module cycle). A failed
 * lookup falls back to the stale cache, or leaves usage undefined (the selector
 * treats that as "unknown" rather than failing).
 */
async function attachUsage(records: AccountRecord[]): Promise<SelectableAccount[]> {
  const ttlMs = usageTtlMs();
  const { fetchUsageForKey } = await import("../client/usage.js");
  const fetchedAt = new Date().toISOString();
  return Promise.all(
    records.map(async (rec): Promise<SelectableAccount> => {
      const base: SelectableAccount = { key: rec.meta.key, email: rec.meta.email, meta: rec.meta };
      const cached = rec.meta.usageCache;
      if (isFreshCache(cached, ttlMs)) {
        return { ...base, usage: cacheToUsage(cached as UsageCacheEntry) };
      }
      try {
        const snap = await fetchUsageForKey(rec.meta.key);
        const entry = snapshotToCache(snap, fetchedAt);
        await writeUsageCache(rec.meta.key, entry).catch(() => undefined);
        return { ...base, usage: cacheToUsage(entry) };
      } catch {
        return cached ? { ...base, usage: cacheToUsage(cached) } : base;
      }
    }),
  );
}

/**
 * Return the enrolled accounts as backend candidates, ordered by the active
 * selection strategy. Disabled accounts are excluded. Throws
 * {@link NotAuthenticatedError} when no usable account exists.
 */
export async function loadAuthCandidates(
  ctx?: SelectionContext,
): Promise<AccountCandidate[]> {
  const records = await readAccountRecords();
  const enabled = records.filter((r) => r.meta.disabled !== true);
  if (enabled.length === 0) throw new NotAuthenticatedError();

  const selector = getSelector(await getStrategyName());
  const byKey = new Map(enabled.map((r) => [r.meta.key, r]));
  const selectables = selector.requiresUsage
    ? await attachUsage(enabled)
    : enabled.map(toSelectable);
  const ordered = selector.order(selectables, ctx);

  const candidates: AccountCandidate[] = [];
  for (const sel of ordered) {
    const rec = byKey.get(sel.key);
    if (rec) candidates.push(makeCandidate(rec));
  }
  // Defensive: if a selector dropped/duplicated entries, fall back to all.
  if (candidates.length === 0) return enabled.map(makeCandidate);
  return candidates;
}

async function activeRecord(): Promise<AccountRecord | null> {
  const key = await getActiveKey();
  if (key) {
    const rec = await readAccount(key);
    if (rec) return rec;
  }
  const all = await readAccountRecords();
  return all[0] ?? null;
}

/**
 * Load the *active* account, refreshing proactively if near expiry. Retained
 * for callers that want the single active account rather than the selection
 * pool (the backend loop uses {@link loadAuthCandidates}).
 */
export async function loadActiveAuth(): Promise<ActiveAuth> {
  const rec = await activeRecord();
  if (!rec) throw new NotAuthenticatedError();
  if (isExpired(rec.auth.tokens.access_token, SKEW_SECONDS)) {
    return toActiveAuth(await refreshAccountByKey(rec.meta.key), rec.meta.key);
  }
  return toActiveAuth(rec.auth, rec.meta.key);
}

/** Force a refresh of the active account — e.g. after a 401. */
export async function forceRefresh(): Promise<ActiveAuth> {
  const rec = await activeRecord();
  if (!rec) throw new NotAuthenticatedError();
  return toActiveAuth(await refreshAccountByKey(rec.meta.key), rec.meta.key);
}

/**
 * Resolve auth for a *specific* enrolled account (not the selection pool),
 * refreshing proactively if near expiry. Used by per-account queries such as
 * the usage lookup, which must talk to each account individually rather than
 * a randomly-selected one.
 */
export async function resolveAuthForKey(key: string): Promise<ActiveAuth> {
  const rec = await readAccount(key);
  if (!rec) throw new NotAuthenticatedError();
  if (isExpired(rec.auth.tokens.access_token, SKEW_SECONDS)) {
    return toActiveAuth(await refreshAccountByKey(key), key);
  }
  return toActiveAuth(rec.auth, key);
}

/** Force a refresh of a specific account — e.g. after a 401 on its usage call. */
export async function refreshAuthForKey(key: string): Promise<ActiveAuth> {
  return toActiveAuth(await refreshAccountByKey(key), key);
}
