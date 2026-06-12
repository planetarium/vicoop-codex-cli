import type { AccountMeta } from "../account-store.js";

/**
 * Usage view handed to usage-aware selectors. Decoupled from the client/usage
 * wire types on purpose, so the selection layer has no dependency on the HTTP
 * client. The loader fills this in (from a fresh fetch or the per-account TTL
 * cache) only for selectors that set `requiresUsage`.
 */
export interface UsageWindowView {
  /** Remaining share of this window, 0–100. */
  remainingPercent?: number;
  /** Absolute reset time (epoch seconds) — preferred, age-independent. */
  resetAtEpoch?: number;
  /** Seconds-until-reset as seen at fetch time (fallback when resetAtEpoch absent). */
  resetAfterSeconds?: number;
}

export interface UsageForSelection {
  planType?: string;
  limitReached?: boolean;
  /** Short rolling window (typically 5h). */
  primary?: UsageWindowView;
  /** Long rolling window (typically weekly). */
  secondary?: UsageWindowView;
  /** Epoch seconds when this snapshot was fetched (to age resetAfterSeconds). */
  fetchedAtEpoch?: number;
}

/** A view of an enrolled account passed to a selector (no secrets needed to order). */
export interface SelectableAccount {
  key: string;
  email?: string;
  meta: AccountMeta;
  /** Populated by the loader only when the active selector sets `requiresUsage`. */
  usage?: UsageForSelection;
}

/**
 * Opaque hints about the request being made. Today only `reason` is set; future
 * strategies (quota/health/model-aware routing) can read richer fields here
 * without changing the selector contract.
 */
export interface SelectionContext {
  reason?: string;
}

/**
 * Pluggable account-selection policy. A selector returns the **full ordered
 * candidate list**: the head is the primary pick and the rest is the fallback
 * order the backend loop walks on failure. This single method is the only
 * extension point — new policies implement it and register a name.
 */
export interface AccountSelector {
  readonly name: string;
  /**
   * When true, the loader populates {@link SelectableAccount.usage} (fetching
   * per-account usage, cached with a TTL) before calling `order`.
   */
  readonly requiresUsage?: boolean;
  order(accounts: SelectableAccount[], ctx?: SelectionContext): SelectableAccount[];
}
