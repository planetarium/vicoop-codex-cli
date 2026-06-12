import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const home = mkdtempSync(path.join(os.tmpdir(), "vcx-resolve-"));
process.env.VICOOP_CODEX_HOME = home;

import {
  getActiveKey,
  readAccountRecords,
  resolveSelector,
  setActive,
  setDisabled,
  upsertAccount,
} from "./account-store.js";
import type { AuthFile } from "./store.js";

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
        "https://api.openai.com/auth": { chatgpt_account_id: accountId },
      }),
      access_token: jwt({ exp }),
      refresh_token: `refresh-${accountId}`,
      account_id: accountId,
    },
    last_refresh: new Date().toISOString(),
  };
}

test("resolveSelector: exact key, case-insensitive email, unambiguous prefix, ambiguity, miss", async () => {
  await upsertAccount(makeAuth("acc-alpha", "alice@example.com"), { makeActive: true });
  await upsertAccount(makeAuth("acc-beta", "bob@example.com"), { makeActive: false });

  assert.equal((await resolveSelector("acc-alpha")).record?.meta.email, "alice@example.com");
  assert.equal((await resolveSelector("BOB@EXAMPLE.COM")).record?.meta.key, "acc-beta");
  assert.equal((await resolveSelector("acc-al")).record?.meta.key, "acc-alpha");

  const ambiguous = await resolveSelector("acc-");
  assert.equal(ambiguous.record, undefined);
  assert.equal(ambiguous.matches.length, 2);

  const miss = await resolveSelector("nobody");
  assert.equal(miss.record, undefined);
  assert.equal(miss.matches.length, 0);
});

test("setActive switches the mirror; disable excludes from selection", async () => {
  await setActive("acc-beta");
  assert.equal(await getActiveKey(), "acc-beta");

  assert.equal(await setDisabled("acc-alpha", true), true);
  const records = await readAccountRecords();
  assert.equal(records.find((r) => r.meta.key === "acc-alpha")?.meta.disabled, true);
  assert.equal(records.find((r) => r.meta.key === "acc-beta")?.meta.disabled, undefined);
});
