import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { registerSelector } from "../auth/selection/index.js";

// Separate file so the module-level watchdog config differs from
// responses.test.ts: here patient-last is ENABLED (the default). The Node test
// runner isolates each test file in its own process, so these env values apply
// independently. This file verifies that earlier attempts still abort+retry
// fast while the FINAL attempt waits patiently (no watchdog).
registerSelector("test-keyorder", () => ({
  name: "test-keyorder",
  order: (accts) => accts.slice().sort((a, b) => a.key.localeCompare(b.key)),
}));

const home = mkdtempSync(path.join(os.tmpdir(), "vcx-responses-patient-"));
process.env.VICOOP_CODEX_HOME = home;
process.env.VICOOP_CODEX_ACCOUNT_STRATEGY = "test-keyorder";
process.env.VICOOP_CODEX_UPSTREAM_FIRST_HEADER_MS = "30";
process.env.VICOOP_CODEX_UPSTREAM_MAX_RETRIES = "1";
// Patient-last ON (default) — the final attempt runs with the watchdog disabled.
delete process.env.VICOOP_CODEX_UPSTREAM_PATIENT_LAST;
process.env.VICOOP_CODEX_UPSTREAM_LOG = "0";

const { upsertAccount } = await import("../auth/account-store.js");
const { postUpstream } = await import("./responses.js");
type AuthFile = import("../auth/store.js").AuthFile;

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}
function jwt(payload: Record<string, unknown>): string {
  return `e30.${b64url(payload)}.sig`;
}
function makeAuth(accountId: string, email: string): AuthFile {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return {
    auth_mode: "chatgpt",
    tokens: {
      id_token: jwt({
        exp,
        email,
        "https://api.openai.com/auth": {
          chatgpt_account_id: accountId,
          chatgpt_plan_type: "pro",
        },
      }),
      access_token: jwt({ exp }),
      refresh_token: `refresh-${accountId}`,
      account_id: accountId,
    },
    last_refresh: new Date().toISOString(),
  };
}

const origFetch = globalThis.fetch;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function abortError(): Error {
  const e = new Error("The operation was aborted.");
  e.name = "AbortError";
  return e;
}
function hung(signal?: AbortSignal | null): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    signal?.addEventListener("abort", () => reject(abortError()), { once: true });
  });
}

before(async () => {
  await upsertAccount(makeAuth("aaa", "a@example.com"), { makeActive: true });
});

afterEach(() => {
  globalThis.fetch = origFetch;
});

test("patient-last: earlier attempts abort at the watchdog, the final attempt waits", async () => {
  // Every attempt hangs. Attempt 0 (not the last) must be aborted by the
  // watchdog and retried; attempt 1 (the last, patient) must NOT be aborted by
  // the watchdog — only the caller signal (standing in for the deadline) ends it.
  const aborted: boolean[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const idx = aborted.length;
    aborted.push(false);
    init?.signal?.addEventListener("abort", () => {
      aborted[idx] = true;
    }, { once: true });
    return hung(init?.signal);
  }) as typeof fetch;

  const caller = new AbortController();
  const p = postUpstream({ model: "gpt-5.5" }, caller.signal);
  // Swallow the eventual rejection so it can't surface as unhandled while we wait.
  const settled = p.then(
    () => ({ ok: true as const }),
    (err: unknown) => ({ ok: false as const, err }),
  );

  // Well past the 30ms watchdog: attempt 0 should have aborted + retried, and
  // attempt 1 should be in flight and NOT aborted (it is the patient last one).
  await delay(150);
  assert.equal(aborted.length, 2, "should have retried exactly once, then be waiting");
  assert.deepEqual(
    aborted,
    [true, false],
    "attempt 0 aborted by watchdog; attempt 1 patient (not aborted at the watchdog)",
  );

  // The deadline/caller is what bounds a patient attempt.
  caller.abort(abortError());
  const result = await settled;
  assert.equal(result.ok, false, "a wedged patient attempt still fails when the caller aborts");
  assert.equal(aborted[1], true, "the patient attempt is aborted only by the caller signal");
});
