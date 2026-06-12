import type {
  AccountSelector,
  SelectableAccount,
  UsageForSelection,
  UsageWindowView,
} from "./types.js";

/**
 * "Use-it-or-lose-it" policy: prefer the account whose remaining quota would
 * otherwise reset (be wasted) soonest. The priority of each account is its
 * required burn rate
 *
 *     urgency = remaining_percent / seconds_until_reset
 *
 * on the short (primary, ~5h) window — high remaining AND a near reset both
 * raise it. Accounts that can't currently serve (rate-limited, or either window
 * exhausted) sort last so they remain only as fallback. Accounts with no usage
 * data sort in the middle, with a random tiebreak so they aren't starved.
 */

// Floor on time-to-reset: avoids divide-by-zero and stops a single
// about-to-reset account from dominating with an unbounded score.
const RESET_FLOOR_SECONDS = 60;
// A window at/under this remaining percent is treated as exhausted.
const EXHAUSTED_AT_OR_BELOW = 0;

type Tier = 0 | 1 | 2; // 0 = usable (scored), 1 = unknown, 2 = exhausted

interface Scored {
  account: SelectableAccount;
  tier: Tier;
  urgency: number; // meaningful only for tier 0
  jitter: number;
}

function resolveResetSeconds(
  win: UsageWindowView | undefined,
  fetchedAtEpoch: number | undefined,
  nowSec: number,
): number | undefined {
  if (!win) return undefined;
  if (typeof win.resetAtEpoch === "number") {
    return win.resetAtEpoch - nowSec;
  }
  if (typeof win.resetAfterSeconds === "number") {
    const age = typeof fetchedAtEpoch === "number" ? Math.max(0, nowSec - fetchedAtEpoch) : 0;
    return win.resetAfterSeconds - age;
  }
  return undefined;
}

function exhausted(win: UsageWindowView | undefined): boolean {
  return typeof win?.remainingPercent === "number" && win.remainingPercent <= EXHAUSTED_AT_OR_BELOW;
}

function score(usage: UsageForSelection | undefined, nowSec: number): { tier: Tier; urgency: number } {
  if (!usage) return { tier: 1, urgency: 0 };

  if (usage.limitReached || exhausted(usage.primary) || exhausted(usage.secondary)) {
    return { tier: 2, urgency: 0 };
  }

  const remaining = usage.primary?.remainingPercent;
  const resetSeconds = resolveResetSeconds(usage.primary, usage.fetchedAtEpoch, nowSec);
  if (typeof remaining !== "number" || typeof resetSeconds !== "number") {
    return { tier: 1, urgency: 0 };
  }

  const t = Math.max(resetSeconds, RESET_FLOOR_SECONDS);
  return { tier: 0, urgency: remaining / t };
}

export class BurnRateSelector implements AccountSelector {
  readonly name = "burn-rate";
  readonly requiresUsage = true;

  order(accounts: SelectableAccount[]): SelectableAccount[] {
    const nowSec = Math.floor(Date.now() / 1000);
    const scored: Scored[] = accounts.map((account) => ({
      account,
      ...score(account.usage, nowSec),
      jitter: Math.random(),
    }));

    scored.sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      if (a.tier === 0) return b.urgency - a.urgency; // higher burn rate first
      return a.jitter - b.jitter; // random within unknown / exhausted tiers
    });

    return scored.map((s) => s.account);
  }
}
