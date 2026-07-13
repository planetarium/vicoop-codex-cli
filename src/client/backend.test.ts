import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { registerSelector } from "../auth/selection/index.js";

// A deterministic ordering strategy so the fallback walk is predictable in
// tests (the production default is random).
registerSelector("test-keyorder", () => ({
  name: "test-keyorder",
  order: (accts) => accts.slice().sort((a, b) => a.key.localeCompare(b.key)),
}));

const home = mkdtempSync(path.join(os.tmpdir(), "vcx-backend-"));
process.env.VICOOP_CODEX_HOME = home;
process.env.VICOOP_CODEX_ACCOUNT_STRATEGY = "test-keyorder";

// Imported after env is set; account-store reads VICOOP_CODEX_HOME lazily.
const { upsertAccount } = await import("../auth/account-store.js");
const {
  fetchCodexBackend,
  isFallbackWorthyStatus,
  codexUserAgent,
  buildCodexHeaders,
  CODEX_BACKEND_CLIENT_VERSION,
} = await import("./backend.js");
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
let calls: string[] = [];

function stub(byAccount: Record<string, number>): void {
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const acct = headers.get("ChatGPT-Account-ID") ?? "?";
    calls.push(acct);
    const status = byAccount[acct] ?? 500;
    return new Response(status === 200 ? "ok" : "err", { status });
  }) as typeof fetch;
}

before(async () => {
  await upsertAccount(makeAuth("aaa", "a@example.com"), { makeActive: true });
  await upsertAccount(makeAuth("bbb", "b@example.com"), { makeActive: false });
});

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  globalThis.fetch = origFetch;
});

test("falls back to a healthy account on a fallback-worthy status (429)", async () => {
  stub({ aaa: 429, bbb: 200 });
  const res = await fetchCodexBackend("/responses", { method: "POST", body: "{}" });
  assert.equal(res.status, 200);
  assert.deepEqual(calls, ["aaa", "bbb"]);
});

test("does NOT fall back on a request-level error (400)", async () => {
  stub({ aaa: 400, bbb: 200 });
  const res = await fetchCodexBackend("/responses", { method: "POST", body: "{}" });
  assert.equal(res.status, 400);
  assert.deepEqual(calls, ["aaa"]); // second account never tried
});

test("returns the last candidate's error when every account fails", async () => {
  stub({ aaa: 429, bbb: 503 });
  const res = await fetchCodexBackend("/responses", { method: "POST", body: "{}" });
  assert.equal(res.status, 503);
  assert.deepEqual(calls, ["aaa", "bbb"]);
});

test("onAccount reports the account whose response is returned (post-fallback)", async () => {
  stub({ aaa: 429, bbb: 200 });
  let used: { key: string; email?: string } | undefined;
  const res = await fetchCodexBackend(
    "/responses",
    { method: "POST", body: "{}" },
    undefined,
    { onAccount: (info) => { used = info; } },
  );
  assert.equal(res.status, 200);
  assert.equal(used?.key, "bbb"); // not the 429'd "aaa"
  assert.equal(used?.email, "b@example.com");
});

test("codexUserAgent carries the codex_cli_rs/<version> gate prefix (unlocks gpt-5.6-luna)", () => {
  const ua = codexUserAgent();
  // The ChatGPT Codex backend only routes gpt-5.6-luna to a live engine when
  // the UA prefix matches the official CLI signature; a stale/plain UA 404s.
  // (openai/codex#31967) Guard the exact prefix + version pinning here.
  assert.equal(
    ua.startsWith(`codex_cli_rs/${CODEX_BACKEND_CLIENT_VERSION} `),
    true,
    `UA must start with codex_cli_rs/<version>, got: ${ua}`,
  );
  // Keep honest vicoop attribution in the suffix (the gate ignores it).
  assert.match(ua, /vicoop-codex-cli\//);
});

test("buildCodexHeaders sends the codex_cli_rs UA + originator pair", () => {
  const headers = buildCodexHeaders({
    accessToken: "tok",
    accountId: "acct-1",
  } as never);
  assert.equal(headers.get("originator"), "codex_cli_rs");
  assert.equal(headers.get("User-Agent"), codexUserAgent());
  assert.equal(
    headers.get("User-Agent")?.startsWith("codex_cli_rs/"),
    true,
    "originator+UA must both present the codex_cli_rs identity (AND-gate)",
  );
});

test("isFallbackWorthyStatus policy", () => {
  for (const s of [401, 403, 408, 409, 425, 429, 500, 502, 503]) {
    assert.equal(isFallbackWorthyStatus(s), true, `expected ${s} fallback-worthy`);
  }
  for (const s of [200, 400, 404, 413, 422]) {
    assert.equal(isFallbackWorthyStatus(s), false, `expected ${s} NOT fallback-worthy`);
  }
});
