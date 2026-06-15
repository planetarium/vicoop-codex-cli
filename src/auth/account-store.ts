import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import * as path from "node:path";
import { decodeJwt, extractChatGptClaims } from "./jwt.js";
import {
  accountsDir,
  clearAuth,
  migrateLegacyDirIfNeeded,
  readAuth,
  statePath,
  writeAuth,
  type AuthFile,
} from "./store.js";

/**
 * Multi-account store. The single-account `auth.json` (managed by `store.ts`)
 * is kept as a mirror of whichever account is *active*, so every existing
 * reader and command keeps working unchanged. The real pool lives here:
 *
 *   $VICOOP_CODEX_HOME/accounts/<key>.json   one record per enrolled account
 *   $VICOOP_CODEX_HOME/state.json            { activeKey, strategy }
 *
 * `key` is a stable per-account id derived from the ChatGPT claims; `email`
 * is carried for display and as a human-friendly selector.
 */

/**
 * Cached usage snapshot, used by usage-aware selection strategies so they don't
 * fetch on every request. `reset*At` are absolute epoch seconds (age-independent);
 * `reset*After` are the seconds-until-reset seen at `fetchedAt` (fallback).
 */
export interface UsageCacheEntry {
  fetchedAt: string;
  planType?: string;
  limitReached?: boolean;
  primaryRemaining?: number;
  primaryResetAt?: number;
  primaryResetAfter?: number;
  secondaryRemaining?: number;
  secondaryResetAt?: number;
  secondaryResetAfter?: number;
}

export interface AccountMeta {
  /** Stable per-account id; also the filename stem. */
  key: string;
  /** Email from the id_token, when present — display + selector. */
  email?: string;
  /** ISO timestamp the account was first enrolled. */
  addedAt: string;
  /** ISO timestamp of the last successful backend call on this account. */
  lastUsedAt?: string;
  /** Last error message recorded for this account (truncated). */
  lastError?: string;
  /** ISO timestamp of the last recorded error. */
  lastErrorAt?: string;
  /** When true, the account is excluded from automatic selection. */
  disabled?: boolean;
  /** TTL-cached usage snapshot for usage-aware selection. */
  usageCache?: UsageCacheEntry;
}

export interface AccountRecord {
  auth: AuthFile;
  meta: AccountMeta;
}

export interface CliState {
  /** Key of the account mirrored into `auth.json`. */
  activeKey?: string;
  /** Persisted selection strategy name (env var overrides this). */
  strategy?: string;
}

export interface SelectorResolution {
  /** The unique match, if exactly one account matched the selector. */
  record?: AccountRecord;
  /** All accounts that matched (length !== 1 means ambiguous / none). */
  matches: AccountRecord[];
}

const STRATEGY_ENV = "VICOOP_CODEX_ACCOUNT_STRATEGY";

// --- low-level JSON IO -------------------------------------------------------

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    await fs.chmod(filePath, 0o600);
  } catch {
    // best effort on platforms without chmod semantics (e.g. Windows)
  }
}

function accountFilePath(key: string): string {
  return path.join(accountsDir(), `${key}.json`);
}

// --- key / email derivation --------------------------------------------------

function sanitizeKey(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128);
  return cleaned.length > 0 ? cleaned : "account";
}

/** Derive a stable account key from the stored credentials. */
export function deriveKey(auth: AuthFile): string {
  let accountId: string | undefined;
  let userId: string | undefined;
  try {
    const claims = extractChatGptClaims(auth.tokens.id_token);
    accountId = claims.chatgpt_account_id;
    userId = claims.chatgpt_user_id;
  } catch {
    // fall through to the hash fallback
  }
  const raw = accountId || userId || auth.tokens.account_id;
  if (raw && raw.length > 0) return sanitizeKey(raw);
  const hash = createHash("sha256")
    .update(auth.tokens.refresh_token || auth.tokens.access_token || "")
    .digest("hex")
    .slice(0, 16);
  return `acct-${hash}`;
}

/** Email from the id_token, when present. */
export function deriveEmail(auth: AuthFile): string | undefined {
  try {
    const payload = decodeJwt(auth.tokens.id_token);
    return typeof payload.email === "string" ? payload.email : undefined;
  } catch {
    return undefined;
  }
}

// --- raw pool/state helpers (NO migration; used inside migration) ------------

async function listRecordsRaw(): Promise<AccountRecord[]> {
  let names: string[];
  try {
    names = await fs.readdir(accountsDir());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const records: AccountRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const rec = await readJsonFile<AccountRecord>(path.join(accountsDir(), name));
    if (rec && rec.auth && rec.meta && typeof rec.meta.key === "string") {
      records.push(rec);
    }
  }
  // Deterministic order so callers (and tests) see a stable list before the
  // selector reorders it.
  records.sort((a, b) => a.meta.key.localeCompare(b.meta.key));
  return records;
}

async function readRecordRaw(key: string): Promise<AccountRecord | null> {
  return readJsonFile<AccountRecord>(accountFilePath(key));
}

async function writeRecordRaw(rec: AccountRecord): Promise<void> {
  await writeJsonFile(accountFilePath(rec.meta.key), rec);
}

async function removeRecordRaw(key: string): Promise<void> {
  try {
    await fs.unlink(accountFilePath(key));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

async function readStateRaw(): Promise<CliState> {
  return (await readJsonFile<CliState>(statePath())) ?? {};
}

async function writeStateRaw(state: CliState): Promise<void> {
  await writeJsonFile(statePath(), state);
}

// --- one-time migration ------------------------------------------------------

let migrated: Promise<void> | null = null;

/**
 * Idempotent migration: run the legacy directory rename, then — if the pool is
 * empty but a single-account `auth.json` exists — import it as the first
 * enrolled (and active) account. Transparent for current single-account users.
 */
export function ensureMigrated(): Promise<void> {
  if (!migrated) migrated = doMigrate();
  return migrated;
}

async function doMigrate(): Promise<void> {
  await migrateLegacyDirIfNeeded();
  const existing = await listRecordsRaw();
  if (existing.length > 0) return;
  const legacy = await readAuth();
  if (!legacy) return;
  const rec = recordFromAuth(legacy);
  await writeRecordRaw(rec);
  const state = await readStateRaw();
  if (!state.activeKey) await writeStateRaw({ ...state, activeKey: rec.meta.key });
}

function recordFromAuth(auth: AuthFile): AccountRecord {
  return {
    auth,
    meta: {
      key: deriveKey(auth),
      email: deriveEmail(auth),
      addedAt: new Date().toISOString(),
    },
  };
}

// --- public API --------------------------------------------------------------

export async function readAccountRecords(): Promise<AccountRecord[]> {
  await ensureMigrated();
  return listRecordsRaw();
}

export async function readAccount(key: string): Promise<AccountRecord | null> {
  await ensureMigrated();
  return readRecordRaw(key);
}

export async function getActiveKey(): Promise<string | undefined> {
  await ensureMigrated();
  return (await readStateRaw()).activeKey;
}

/**
 * Enroll or replace an account from a freshly-obtained credential set.
 * Activates it (mirroring into `auth.json`) when `makeActive` is set or when
 * there is no active account yet — so the first enrollment is always active.
 */
export async function upsertAccount(
  auth: AuthFile,
  opts: { makeActive?: boolean } = {},
): Promise<AccountRecord> {
  await ensureMigrated();
  const key = deriveKey(auth);
  const existing = await readRecordRaw(key);
  const rec: AccountRecord = existing
    ? { auth, meta: { ...existing.meta, email: deriveEmail(auth) ?? existing.meta.email } }
    : recordFromAuth(auth);
  await writeRecordRaw(rec);

  const state = await readStateRaw();
  const shouldActivate = opts.makeActive === true || !state.activeKey;
  if (shouldActivate) {
    await writeStateRaw({ ...state, activeKey: key });
    await writeAuth(auth);
  } else if (state.activeKey === key) {
    await writeAuth(auth);
  }
  return rec;
}

/** Persist refreshed tokens for one account, keeping its metadata. */
export async function writeAccountAuth(key: string, auth: AuthFile): Promise<void> {
  await ensureMigrated();
  const existing = await readRecordRaw(key);
  const meta: AccountMeta = existing
    ? { ...existing.meta, email: deriveEmail(auth) ?? existing.meta.email }
    : { key, email: deriveEmail(auth), addedAt: new Date().toISOString() };
  await writeRecordRaw({ auth, meta });
  const state = await readStateRaw();
  if (state.activeKey === key) await writeAuth(auth);
}

/** Make `key` the active account (updates the `auth.json` mirror). */
export async function setActive(key: string): Promise<void> {
  await ensureMigrated();
  const rec = await readRecordRaw(key);
  if (!rec) throw new Error(`no such account: ${key}`);
  const state = await readStateRaw();
  await writeStateRaw({ ...state, activeKey: key });
  await writeAuth(rec.auth);
}

/** Remove one account; repoint the active account if it was the one removed. */
export async function removeAccount(
  key: string,
): Promise<{ removed: boolean; newActiveKey?: string }> {
  await ensureMigrated();
  const rec = await readRecordRaw(key);
  if (!rec) return { removed: false };
  await removeRecordRaw(key);

  const state = await readStateRaw();
  if (state.activeKey !== key) return { removed: true };

  const remaining = await listRecordsRaw();
  const next = remaining[0];
  if (next) {
    await writeStateRaw({ ...state, activeKey: next.meta.key });
    await writeAuth(next.auth);
    return { removed: true, newActiveKey: next.meta.key };
  }
  await writeStateRaw({ ...state, activeKey: undefined });
  await clearAuth();
  return { removed: true };
}

/** Remove every account and clear the mirror. Returns how many were removed. */
export async function removeAll(): Promise<number> {
  await ensureMigrated();
  const records = await listRecordsRaw();
  for (const rec of records) await removeRecordRaw(rec.meta.key);
  const state = await readStateRaw();
  await writeStateRaw({ ...state, activeKey: undefined });
  await clearAuth();
  return records.length;
}

async function patchMeta(key: string, patch: Partial<AccountMeta>): Promise<void> {
  const rec = await readRecordRaw(key);
  if (!rec) return;
  await writeRecordRaw({ auth: rec.auth, meta: { ...rec.meta, ...patch } });
}

export async function markUsed(key: string): Promise<void> {
  await ensureMigrated();
  await patchMeta(key, {
    lastUsedAt: new Date().toISOString(),
    lastError: undefined,
    lastErrorAt: undefined,
  });
}

export async function markError(key: string, message: string): Promise<void> {
  await ensureMigrated();
  await patchMeta(key, {
    lastError: message.slice(0, 500),
    lastErrorAt: new Date().toISOString(),
  });
}

/** Toggle whether an account participates in automatic selection. */
export async function setDisabled(key: string, disabled: boolean): Promise<boolean> {
  await ensureMigrated();
  const rec = await readRecordRaw(key);
  if (!rec) return false;
  await patchMeta(key, { disabled });
  return true;
}

/** Cache a usage snapshot for usage-aware selection. */
export async function writeUsageCache(key: string, entry: UsageCacheEntry): Promise<void> {
  await ensureMigrated();
  await patchMeta(key, { usageCache: entry });
}

/** Effective selection strategy: env var wins, else persisted, else "burn-rate". */
export async function getStrategyName(): Promise<string> {
  await ensureMigrated();
  const env = process.env[STRATEGY_ENV]?.trim();
  if (env) return env;
  const state = await readStateRaw();
  const persisted = state.strategy?.trim();
  return persisted && persisted.length > 0 ? persisted : "burn-rate";
}

export async function setStrategyName(name: string): Promise<void> {
  await ensureMigrated();
  const state = await readStateRaw();
  await writeStateRaw({ ...state, strategy: name });
}

/**
 * Resolve a user-supplied selector to an account. Matches, in order: exact
 * key, case-insensitive email (must be unique), then unambiguous key prefix.
 */
export async function resolveSelector(selector: string): Promise<SelectorResolution> {
  await ensureMigrated();
  const records = await listRecordsRaw();
  const sel = selector.trim();
  const selLower = sel.toLowerCase();

  const exact = records.find((r) => r.meta.key === sel);
  if (exact) return { record: exact, matches: [exact] };

  const byEmail = records.filter((r) => r.meta.email?.toLowerCase() === selLower);
  if (byEmail.length === 1) return { record: byEmail[0], matches: byEmail };
  if (byEmail.length > 1) return { matches: byEmail };

  const byPrefix = records.filter((r) => r.meta.key.startsWith(sel));
  if (byPrefix.length === 1) return { record: byPrefix[0], matches: byPrefix };
  return { matches: byPrefix };
}
