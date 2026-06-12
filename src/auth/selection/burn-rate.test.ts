import { test } from "node:test";
import assert from "node:assert/strict";
import { BurnRateSelector } from "./burn-rate.js";
import type { SelectableAccount, UsageForSelection } from "./types.js";

const NOW = Math.floor(Date.now() / 1000);

interface Opts {
  remaining?: number;
  resetInSec?: number;
  secRemaining?: number;
  limitReached?: boolean;
  noUsage?: boolean;
}

function acct(key: string, opts: Opts): SelectableAccount {
  const base: SelectableAccount = { key, meta: { key, addedAt: "2020-01-01T00:00:00Z" } };
  if (opts.noUsage) return base;
  const usage: UsageForSelection = {
    limitReached: opts.limitReached,
    fetchedAtEpoch: NOW,
    primary:
      opts.remaining !== undefined
        ? { remainingPercent: opts.remaining, resetAtEpoch: NOW + (opts.resetInSec ?? 3600) }
        : undefined,
    secondary: { remainingPercent: opts.secRemaining ?? 90, resetAtEpoch: NOW + 600000 },
  };
  return { ...base, usage };
}

function order(accts: SelectableAccount[]): string[] {
  return new BurnRateSelector().order(accts).map((a) => a.key);
}

test("near-reset account is preferred over a far-reset one (same remaining)", () => {
  const out = order([acct("far", { remaining: 80, resetInSec: 7200 }), acct("near", { remaining: 80, resetInSec: 600 })]);
  assert.equal(out[0], "near");
});

test("more-to-lose account is preferred at equal time-to-reset", () => {
  const out = order([acct("low", { remaining: 20, resetInSec: 600 }), acct("high", { remaining: 80, resetInSec: 600 })]);
  assert.equal(out[0], "high");
});

test("rate-limited and exhausted accounts sort last; usable first, unknown in the middle", () => {
  const out = order([
    acct("limited", { remaining: 90, resetInSec: 600, limitReached: true }),
    acct("unknown", { noUsage: true }),
    acct("usable", { remaining: 50, resetInSec: 1200 }),
  ]);
  assert.equal(out[0], "usable");
  assert.equal(out[1], "unknown");
  assert.equal(out[2], "limited");
});

test("an exhausted weekly window gates the account out even if the 5h window is healthy", () => {
  const out = order([
    acct("weeklyDone", { remaining: 90, resetInSec: 300, secRemaining: 0 }),
    acct("ok", { remaining: 40, resetInSec: 3600 }),
  ]);
  assert.equal(out[0], "ok");
  assert.equal(out[1], "weeklyDone");
});

test("BurnRateSelector advertises that it requires usage", () => {
  assert.equal(new BurnRateSelector().requiresUsage, true);
});
