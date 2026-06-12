import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const home = mkdtempSync(path.join(os.tmpdir(), "vcx-migrate-"));
process.env.VICOOP_CODEX_HOME = home;

import { getActiveKey, readAccountRecords } from "./account-store.js";
import type { AuthFile } from "./store.js";

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}
function jwt(payload: Record<string, unknown>): string {
  return `e30.${b64url(payload)}.sig`;
}
function legacyAuth(): AuthFile {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return {
    auth_mode: "chatgpt",
    tokens: {
      id_token: jwt({
        exp,
        email: "legacy@example.com",
        "https://api.openai.com/auth": { chatgpt_account_id: "legacy-acct" },
      }),
      access_token: jwt({ exp }),
      refresh_token: "legacy-refresh",
      account_id: "legacy-acct",
    },
    last_refresh: new Date().toISOString(),
  };
}

test("imports a legacy single auth.json into the pool and marks it active", async () => {
  await fs.writeFile(
    path.join(home, "auth.json"),
    JSON.stringify(legacyAuth(), null, 2),
    "utf8",
  );

  const records = await readAccountRecords();
  assert.equal(records.length, 1);
  assert.equal(records[0].meta.email, "legacy@example.com");
  assert.equal(records[0].meta.key, "legacy-acct");

  const active = await getActiveKey();
  assert.equal(active, "legacy-acct");
});
