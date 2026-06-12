import { test } from "node:test";
import assert from "node:assert/strict";
import { RandomSelector } from "./random.js";
import type { SelectableAccount } from "./types.js";

function mk(key: string): SelectableAccount {
  return { key, meta: { key, addedAt: "2020-01-01T00:00:00.000Z" } };
}

test("RandomSelector returns every account exactly once (a permutation)", () => {
  const sel = new RandomSelector();
  const input = ["a", "b", "c", "d", "e"].map(mk);
  const out = sel.order(input);
  assert.equal(out.length, input.length);
  assert.deepEqual(
    new Set(out.map((a) => a.key)),
    new Set(input.map((a) => a.key)),
  );
});

test("RandomSelector does not mutate its input", () => {
  const sel = new RandomSelector();
  const input = ["a", "b", "c"].map(mk);
  const before = input.map((a) => a.key);
  sel.order(input);
  assert.deepEqual(input.map((a) => a.key), before);
});

test("RandomSelector handles empty and single-element inputs", () => {
  const sel = new RandomSelector();
  assert.equal(sel.order([]).length, 0);
  assert.deepEqual(sel.order([mk("solo")]).map((a) => a.key), ["solo"]);
});
