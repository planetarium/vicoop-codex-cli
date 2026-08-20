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
  LEGACY_USER_AGENT,
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

test("codexUserAgent is conditional: legacy (cache-safe) by default, codex_cli_rs only for luna", () => {
  // Non-luna models and model-less calls keep the legacy identity — presenting
  // codex_cli_rs on them collapses prompt-cache hit rates ~5x (#48).
  assert.equal(codexUserAgent(), LEGACY_USER_AGENT);
  assert.equal(codexUserAgent("gpt-5.5"), LEGACY_USER_AGENT);
  assert.equal(codexUserAgent("gpt-5.6-sol"), LEGACY_USER_AGENT);
  assert.equal(codexUserAgent("gpt-5.6-terra"), LEGACY_USER_AGENT);

  // gpt-5.6-luna requires the official CLI signature — the backend only routes
  // it to a live engine on the codex_cli_rs UA prefix; a plain UA 404s
  // (openai/codex#31967). Guard the exact prefix + version pinning here.
  for (const luna of ["gpt-5.6-luna", "gpt-5.6-luna-mini"]) {
    const ua = codexUserAgent(luna);
    assert.equal(
      ua.startsWith(`codex_cli_rs/${CODEX_BACKEND_CLIENT_VERSION} `),
      true,
      `UA for ${luna} must start with codex_cli_rs/<version>, got: ${ua}`,
    );
    // Keep honest vicoop attribution in the suffix (the gate ignores it).
    assert.match(ua, /vicoop-codex-cli\//);
  }
});

test("buildCodexHeaders picks the UA from the target model, originator stays fixed", () => {
  const auth = { accessToken: "tok", accountId: "acct-1" } as never;

  const plain = buildCodexHeaders(auth);
  assert.equal(plain.get("originator"), "codex_cli_rs");
  assert.equal(plain.get("User-Agent"), LEGACY_USER_AGENT);

  const luna = buildCodexHeaders(auth, undefined, "gpt-5.6-luna");
  assert.equal(luna.get("originator"), "codex_cli_rs");
  assert.equal(
    luna.get("User-Agent")?.startsWith("codex_cli_rs/"),
    true,
    "luna requests must present the codex_cli_rs identity (AND-gate)",
  );
});

test("fetchCodexBackend threads opts.model into the wire User-Agent", async () => {
  const seen: Array<string | null> = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    seen.push(new Headers(init?.headers).get("User-Agent"));
    return new Response("ok", { status: 200 });
  }) as typeof fetch;

  await fetchCodexBackend("/responses", { method: "POST", body: "{}" });
  await fetchCodexBackend(
    "/responses",
    { method: "POST", body: "{}" },
    undefined,
    { model: "gpt-5.6-luna" },
  );
  assert.equal(seen[0], LEGACY_USER_AGENT);
  assert.equal(seen[1]?.startsWith("codex_cli_rs/"), true);
});

test("isFallbackWorthyStatus policy", () => {
  for (const s of [401, 403, 408, 409, 425, 429, 500, 502, 503]) {
    assert.equal(isFallbackWorthyStatus(s), true, `expected ${s} fallback-worthy`);
  }
  for (const s of [200, 400, 404, 413, 422]) {
    assert.equal(isFallbackWorthyStatus(s), false, `expected ${s} NOT fallback-worthy`);
  }
});
