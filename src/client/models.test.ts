import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeModel } from "./models.js";

test("normalizeModel surfaces a positive-integer context_window", () => {
  assert.deepEqual(normalizeModel({ slug: "gpt-5.6", context_window: 272000 }), {
    id: "gpt-5.6",
    context_window: 272000,
  });
});

test("normalizeModel omits a missing / non-positive / non-integer context_window", () => {
  assert.equal(normalizeModel({ slug: "a" })?.context_window, undefined);
  assert.equal(normalizeModel({ slug: "b", context_window: 0 })?.context_window, undefined);
  assert.equal(normalizeModel({ slug: "c", context_window: -1 })?.context_window, undefined);
  assert.equal(
    normalizeModel({ slug: "d", context_window: 272000.5 })?.context_window,
    undefined,
  );
  assert.equal(
    normalizeModel({ slug: "e", context_window: "272000" })?.context_window,
    undefined,
  );
});

test("normalizeModel prefers slug, keeps name + service_tiers, drops unknown fields", () => {
  const out = normalizeModel({
    slug: "gpt-5.6",
    id: "ignored",
    name: "GPT-5.6",
    context_window: 400000,
    service_tiers: [{ id: "flex", name: "Flex", description: "d" }],
    // an unrelated backend field must not leak through (cast: it's not part of
    // the typed RawCodexModel surface, which is exactly the point)
    ...({ base_instructions: "…" } as Record<string, unknown>),
  });
  assert.deepEqual(out, {
    id: "gpt-5.6",
    name: "GPT-5.6",
    context_window: 400000,
    service_tiers: [{ id: "flex", name: "Flex", description: "d" }],
  });
});

test("normalizeModel returns null when no id/slug/name is present", () => {
  assert.equal(normalizeModel({ context_window: 272000 }), null);
});
