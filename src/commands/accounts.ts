import { runDeviceLogin, runLogin } from "../auth/login.js";
import {
  CloudflareChallengeError,
  DeviceFlowError,
  DeviceFlowNotEnabledError,
} from "../auth/device.js";
import {
  getActiveKey,
  getStrategyName,
  readAccountRecords,
  resolveSelector,
  setActive,
  setDisabled,
  setStrategyName,
  type AccountRecord,
} from "../auth/account-store.js";
import { extractChatGptClaims } from "../auth/jwt.js";
import { hasStrategy, listStrategies } from "../auth/selection/index.js";
import {
  fetchAllAccountUsage,
  fetchUsageForKey,
  type AccountUsage,
  type RateLimitWindow,
} from "../client/usage.js";
import {
  formatCloudflareChallenge,
  formatDeviceFlowNotEnabled,
  printError,
} from "../cli/help-errors.js";

const BIN = "vicoop-codex";

function planOf(rec: AccountRecord): string | undefined {
  try {
    return extractChatGptClaims(rec.auth.tokens.id_token).chatgpt_plan_type;
  } catch {
    return undefined;
  }
}

function listHint(): string {
  return `Run \`${BIN} accounts list\` to see enrolled accounts and their keys.`;
}

/**
 * Resolve a selector to a single account, printing a helpful error and
 * returning null when there is no unique match.
 */
async function resolveOrReport(selector: string): Promise<AccountRecord | null> {
  const { record, matches } = await resolveSelector(selector);
  if (record) return record;
  if (matches.length === 0) {
    printError(`No account matches ${JSON.stringify(selector)}.\n\n${listHint()}`);
  } else {
    printError(
      `Selector ${JSON.stringify(selector)} is ambiguous — it matches: ` +
        `${matches.map((m) => m.meta.key).join(", ")}.\n\n` +
        `Use a more specific key or email.`,
    );
  }
  return null;
}

export interface AccountsListOptions {
  json: boolean;
}

export async function accountsListCommand(opts: AccountsListOptions): Promise<number> {
  const records = await readAccountRecords();
  const activeKey = await getActiveKey();
  const strategy = await getStrategyName();

  if (opts.json) {
    const out = {
      strategy,
      active: activeKey ?? null,
      accounts: records.map((r) => ({
        key: r.meta.key,
        email: r.meta.email ?? null,
        plan: planOf(r) ?? null,
        active: r.meta.key === activeKey,
        disabled: r.meta.disabled === true,
        added_at: r.meta.addedAt,
        last_used_at: r.meta.lastUsedAt ?? null,
        last_error: r.meta.lastError ?? null,
        last_error_at: r.meta.lastErrorAt ?? null,
      })),
    };
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    return 0;
  }

  if (records.length === 0) {
    process.stdout.write(
      `No accounts enrolled.\n\nSign in to add one:\n  $ ${BIN} login\n  $ ${BIN} accounts add\n`,
    );
    return 0;
  }

  process.stdout.write(`strategy: ${strategy}\n\n`);
  for (const r of records) {
    const marker = r.meta.key === activeKey ? "*" : " ";
    const status = r.meta.disabled === true ? "disabled" : "enabled";
    process.stdout.write(
      `${marker} ${r.meta.email ?? "(unknown email)"}  [${r.meta.key}]\n` +
        `    plan: ${planOf(r) ?? "(unknown)"}   status: ${status}\n`,
    );
    if (r.meta.lastUsedAt) process.stdout.write(`    last used:  ${r.meta.lastUsedAt}\n`);
    if (r.meta.lastError) {
      process.stdout.write(`    last error: ${r.meta.lastError} (${r.meta.lastErrorAt ?? "?"})\n`);
    }
  }
  process.stdout.write(`\n(* = active account, mirrored into auth.json)\n`);
  return 0;
}

export interface AccountsAddOptions {
  deviceCode?: boolean;
  noBrowser?: boolean;
  /** Whether to make the new account active. */
  activate: boolean;
}

export async function accountsAddCommand(opts: AccountsAddOptions): Promise<number> {
  try {
    if (opts.deviceCode) {
      await runDeviceLogin({ noBrowser: opts.noBrowser, activate: opts.activate });
    } else {
      await runLogin({ noBrowser: opts.noBrowser, activate: opts.activate });
    }
  } catch (err) {
    if (err instanceof DeviceFlowNotEnabledError) {
      printError(formatDeviceFlowNotEnabled());
      return 1;
    }
    if (err instanceof CloudflareChallengeError) {
      printError(formatCloudflareChallenge());
      return 1;
    }
    if (err instanceof DeviceFlowError) {
      printError(err.message);
      return 1;
    }
    throw err;
  }

  const records = await readAccountRecords();
  process.stderr.write(`Enrolled account. ${records.length} account(s) now available.\n`);
  return 0;
}

export async function accountsUseCommand(selector: string): Promise<number> {
  const rec = await resolveOrReport(selector);
  if (!rec) return 1;
  await setActive(rec.meta.key);
  process.stderr.write(
    `Active account is now ${rec.meta.email ?? rec.meta.key} [${rec.meta.key}].\n`,
  );
  return 0;
}

export async function accountsSetEnabledCommand(
  selector: string,
  enabled: boolean,
): Promise<number> {
  const rec = await resolveOrReport(selector);
  if (!rec) return 1;
  await setDisabled(rec.meta.key, !enabled);
  process.stderr.write(
    `${enabled ? "Enabled" : "Disabled"} account ${rec.meta.email ?? rec.meta.key} [${rec.meta.key}]` +
      `${enabled ? "" : " (excluded from automatic selection)"}.\n`,
  );
  return 0;
}

export async function accountsStrategyCommand(name?: string): Promise<number> {
  const known = listStrategies();
  if (!name) {
    const current = await getStrategyName();
    process.stdout.write(`current strategy: ${current}\n`);
    process.stdout.write(`available:        ${known.join(", ")}\n`);
    const envVal = process.env.VICOOP_CODEX_ACCOUNT_STRATEGY?.trim();
    if (envVal) {
      process.stdout.write(
        `note: VICOOP_CODEX_ACCOUNT_STRATEGY=${JSON.stringify(envVal)} is set and overrides the persisted value.\n`,
      );
    }
    return 0;
  }
  if (!hasStrategy(name)) {
    printError(
      `Unknown strategy ${JSON.stringify(name)}. Available: ${known.join(", ")}.`,
    );
    return 2;
  }
  await setStrategyName(name);
  process.stderr.write(`Selection strategy set to ${name}.\n`);
  return 0;
}

function fmtDuration(seconds?: number): string {
  if (seconds === undefined || seconds < 0) return "?";
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m && !d) parts.push(`${m}m`);
  if (parts.length === 0) parts.push(`${s}s`);
  return parts.join(" ");
}

function fmtWindow(label: string, w?: RateLimitWindow): string {
  if (!w) return `    ${label}: (n/a)`;
  const win = w.limit_window_seconds ? ` / ${fmtDuration(w.limit_window_seconds)} window` : "";
  const reset =
    w.reset_after_seconds !== undefined ? `, resets in ${fmtDuration(w.reset_after_seconds)}` : "";
  return `    ${label}: ${w.remaining_percent}% left (${w.used_percent}% used${win}${reset})`;
}

function usageToJson(r: AccountUsage): Record<string, unknown> {
  return {
    key: r.key,
    email: r.email ?? null,
    error: r.error ?? null,
    plan_type: r.usage?.plan_type ?? null,
    limit_reached: r.usage?.limit_reached ?? null,
    primary: r.usage?.primary ?? null,
    secondary: r.usage?.secondary ?? null,
    credits: r.usage?.credits ?? null,
    raw: r.usage?.raw ?? null,
  };
}

export interface AccountsUsageOptions {
  json: boolean;
  /** Optional selector to query a single account instead of all. */
  selector?: string;
}

export async function accountsUsageCommand(opts: AccountsUsageOptions): Promise<number> {
  let results: AccountUsage[];
  if (opts.selector) {
    const rec = await resolveOrReport(opts.selector);
    if (!rec) return 1;
    try {
      results = [
        { key: rec.meta.key, email: rec.meta.email, usage: await fetchUsageForKey(rec.meta.key) },
      ];
    } catch (err) {
      results = [
        {
          key: rec.meta.key,
          email: rec.meta.email,
          error: err instanceof Error ? err.message : String(err),
        },
      ];
    }
  } else {
    results = await fetchAllAccountUsage();
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(results.map(usageToJson), null, 2) + "\n");
    return results.length > 0 && results.every((r) => r.error) ? 4 : 0;
  }

  if (results.length === 0) {
    process.stdout.write(
      `No accounts enrolled.\n\nSign in to add one:\n  $ ${BIN} login\n  $ ${BIN} accounts add\n`,
    );
    return 0;
  }

  for (const r of results) {
    const head = `${r.email ?? "(unknown email)"}  [${r.key}]`;
    if (r.error) {
      process.stdout.write(`✗ ${head}\n    error: ${r.error}\n`);
      continue;
    }
    const u = r.usage!;
    process.stdout.write(
      `  ${head}\n` +
        `    plan: ${u.plan_type ?? "(unknown)"}${u.limit_reached ? "   ⚠ LIMIT REACHED" : ""}\n` +
        fmtWindow("5h window ", u.primary) +
        "\n" +
        fmtWindow("weekly    ", u.secondary) +
        "\n",
    );
    if (u.credits) {
      const c = u.credits;
      const bal = c.unlimited ? "unlimited" : c.balance ?? (c.has_credits ? "available" : "none");
      process.stdout.write(`    credits: ${bal}\n`);
    }
  }
  process.stdout.write(`\n("X% left" = remaining share of each rolling window)\n`);
  return results.every((r) => r.error) ? 4 : 0;
}
