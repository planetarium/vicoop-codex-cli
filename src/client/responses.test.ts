import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { registerSelector } from "../auth/selection/index.js";

// Deterministic ordering so the single-account fallback walk is predictable.
registerSelector("test-keyorder", () => ({
  name: "test-keyorder",
  order: (accts) => accts.slice().sort((a, b) => a.key.localeCompare(b.key)),
}));

const home = mkdtempSync(path.join(os.tmpdir(), "vcx-responses-"));
process.env.VICOOP_CODEX_HOME = home;
process.env.VICOOP_CODEX_ACCOUNT_STRATEGY = "test-keyorder";
// A fast first-header watchdog + exactly one retry so the stall/retry path runs
// in milliseconds. These are read once at module load, so they must be set
// before importing responses.js below.
process.env.VICOOP_CODEX_UPSTREAM_FIRST_HEADER_MS = "30";
process.env.VICOOP_CODEX_UPSTREAM_MAX_RETRIES = "1";
// Fail fast on every attempt (incl. the last) here so the exhaustion path is
// deterministic; the patient-last behavior is covered in responses.patient.test.ts.
process.env.VICOOP_CODEX_UPSTREAM_PATIENT_LAST = "0";
// No backoff pause between bad-status retries so those paths run instantly.
process.env.VICOOP_CODEX_UPSTREAM_RETRY_BACKOFF_MS = "0";
// Silence the [upstream] stderr instrumentation during tests.
process.env.VICOOP_CODEX_UPSTREAM_LOG = "0";

// Imported after env is set; account-store reads VICOOP_CODEX_HOME lazily.
const { upsertAccount } = await import("../auth/account-store.js");
const { postUpstream, ApiError } = await import("./responses.js");
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

function abortError(): Error {
  const e = new Error("The operation was aborted.");
  e.name = "AbortError";
  return e;
}

// A fetch that never produces response headers until its signal aborts, then
// rejects — modelling the wedged/silent upstream the watchdog exists to break.
function hung(signal?: AbortSignal | null): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    signal?.addEventListener("abort", () => reject(abortError()), { once: true });
  });
}

// A quick, well-formed streaming success (headers arrive immediately).
function sseOk(): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(
        enc.encode(
          `data: ${JSON.stringify({
            type: "response.completed",
            response: { status: "completed" },
          })}\n\n`,
        ),
      );
      c.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

before(async () => {
  await upsertAccount(makeAuth("aaa", "a@example.com"), { makeActive: true });
});

afterEach(() => {
  globalThis.fetch = origFetch;
});

test("postUpstream aborts a stalled attempt and retries a fresh connection", async () => {
  let calls = 0;
  const aborted: boolean[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    calls++;
    if (calls === 1) {
      // First attempt hangs; the watchdog must abort THIS connection.
      init?.signal?.addEventListener("abort", () => aborted.push(true), {
        once: true,
      });
      return hung(init?.signal);
    }
    return sseOk(); // the retry succeeds fast
  }) as typeof fetch;

  const res = await postUpstream({ model: "gpt-5.5" });
  assert.equal(res.status, 200);
  assert.equal(calls, 2, "should have retried exactly once after the stall");
  assert.deepEqual(aborted, [true], "the stalled attempt's fetch must be aborted");
});

test("postUpstream throws upstream_stalled after retries are exhausted", async () => {
  let calls = 0;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    calls++;
    return hung(init?.signal); // every attempt hangs
  }) as typeof fetch;

  await assert.rejects(
    postUpstream({ model: "gpt-5.5" }),
    (err: unknown) => {
      assert.ok(err instanceof ApiError, "expected an ApiError");
      assert.equal((err as InstanceType<typeof ApiError>).status, 504);
      assert.equal((err as InstanceType<typeof ApiError>).detail, "upstream_stalled");
      return true;
    },
  );
  // 1 initial attempt + 1 retry (VICOOP_CODEX_UPSTREAM_MAX_RETRIES=1).
  assert.equal(calls, 2);
});

// A received-but-error response: headers arrive, status is bad (issue #45's
// transient Cloudflare 520 with the OpenAI-branded HTML error page as body).
function badStatus(status: number): Response {
  return new Response("<html>error</html>", { status });
}

test("postUpstream retries a transient 520 and succeeds on the fresh connection", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (calls === 1) return badStatus(520);
    return sseOk();
  }) as typeof fetch;

  const res = await postUpstream({ model: "gpt-5.5" });
  assert.equal(res.status, 200);
  assert.equal(calls, 2, "should have retried exactly once after the 520");
});

test("postUpstream returns the final bad response after retries are exhausted", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return badStatus(520); // every attempt errors
  }) as typeof fetch;

  const res = await postUpstream({ model: "gpt-5.5" });
  // 1 initial attempt + 1 retry (VICOOP_CODEX_UPSTREAM_MAX_RETRIES=1); the last
  // attempt's response is returned as-is so error formatting is unchanged.
  assert.equal(calls, 2);
  assert.equal(res.status, 520);
});

test("postUpstream does not retry a non-retryable status", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return badStatus(400); // caller error — retrying cannot help
  }) as typeof fetch;

  const res = await postUpstream({ model: "gpt-5.5" });
  assert.equal(calls, 1, "a 4xx caller error must not retry");
  assert.equal(res.status, 400);
});

test("postUpstream returns the first response when headers arrive promptly", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return sseOk();
  }) as typeof fetch;

  const res = await postUpstream({ model: "gpt-5.5" });
  assert.equal(res.status, 200);
  assert.equal(calls, 1, "a healthy request must not retry");
});
