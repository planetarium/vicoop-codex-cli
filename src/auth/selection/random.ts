import type { AccountSelector, SelectableAccount } from "./types.js";

/**
 * Default policy: a uniformly-random ordering (Fisher–Yates shuffle). The head
 * is the randomly-chosen primary account; the remainder is a random fallback
 * order. Spreads load across accounts and, on failure, tries the others.
 */
export class RandomSelector implements AccountSelector {
  readonly name = "random";

  order(accounts: SelectableAccount[]): SelectableAccount[] {
    const out = accounts.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
}
