import type { AccountMeta } from "../account-store.js";

/** A view of an enrolled account passed to a selector (no secrets needed to order). */
export interface SelectableAccount {
  key: string;
  email?: string;
  meta: AccountMeta;
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
  order(accounts: SelectableAccount[], ctx?: SelectionContext): SelectableAccount[];
}
