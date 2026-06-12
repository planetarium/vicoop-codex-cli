import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeUsage } from "./usage.js";

test("normalizeUsage maps the upstream RateLimitStatusPayload shape", () => {
  const raw = {
    plan_type: "pro",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: {
        used_percent: 37,
        limit_window_seconds: 18000,
        reset_after_seconds: 3600,
        reset_at: 1900000000,
      },
      secondary_window: {
        used_percent: 12,
        limit_window_seconds: 604800,
        reset_after_seconds: 200000,
        reset_at: 1900600000,
      },
    },
    credits: { has_credits: true, unlimited: false, balance: "5.00" },
  };
  const u = normalizeUsage(raw);
  assert.equal(u.plan_type, "pro");
  assert.equal(u.allowed, true);
  assert.equal(u.limit_reached, false);
  assert.equal(u.primary?.used_percent, 37);
  assert.equal(u.primary?.remaining_percent, 63);
  assert.equal(u.primary?.limit_window_seconds, 18000);
  assert.equal(u.secondary?.remaining_percent, 88);
  assert.equal(u.credits?.balance, "5.00");
  assert.equal(u.raw, raw); // raw passed through verbatim
});

test("normalizeUsage clamps remaining and tolerates missing windows", () => {
  const u = normalizeUsage({
    plan_type: "plus",
    rate_limit: { allowed: false, limit_reached: true, primary_window: { used_percent: 130 } },
  });
  assert.equal(u.primary?.remaining_percent, 0); // clamped
  assert.equal(u.secondary, undefined);
  assert.equal(u.limit_reached, true);
});

test("normalizeUsage is defensive against empty / malformed payloads", () => {
  assert.deepEqual(normalizeUsage(null).primary, undefined);
  assert.deepEqual(normalizeUsage({}).secondary, undefined);
  const partial = normalizeUsage({ rate_limit: { primary_window: { reset_after_seconds: 60 } } });
  // used_percent absent but reset present → window still surfaces, used defaults to 0
  assert.equal(partial.primary?.used_percent, 0);
  assert.equal(partial.primary?.remaining_percent, 100);
  assert.equal(partial.primary?.reset_after_seconds, 60);
});
