import { authFilePath } from "../auth/store.js";
import {
  readAccountRecords,
  removeAccount,
  removeAll,
  resolveSelector,
} from "../auth/account-store.js";
import { printError } from "../cli/help-errors.js";

const BIN = "vicoop-codex";

export interface LogoutCmdOptions {
  /** Email or account key to log out. */
  account?: string;
  /** Log out every enrolled account. */
  all?: boolean;
}

async function printUsage(): Promise<number> {
  const records = await readAccountRecords();
  const lines = [
    "Specify which account to log out.",
    "",
    "Usage:",
    `  $ ${BIN} logout --account <email|key>   # remove one account`,
    `  $ ${BIN} logout --all                   # remove every account`,
  ];
  if (records.length > 0) {
    lines.push("", "Enrolled accounts:");
    for (const r of records) {
      lines.push(`  - ${r.meta.email ?? "(unknown email)"}  [${r.meta.key}]`);
    }
    lines.push("", `Full detail: $ ${BIN} accounts list`);
  } else {
    lines.push("", "(no accounts are currently enrolled)");
  }
  printError(lines.join("\n"));
  return 2;
}

export async function logoutCommand(opts: LogoutCmdOptions): Promise<number> {
  if (opts.all) {
    const count = await removeAll();
    process.stderr.write(
      `Logged out ${count} account(s). Removed ${authFilePath()}.\n`,
    );
    return 0;
  }

  const selector = opts.account?.trim();
  if (!selector) {
    return printUsage();
  }

  const { record, matches } = await resolveSelector(selector);
  if (!record) {
    if (matches.length === 0) {
      printError(
        `No account matches ${JSON.stringify(selector)}.\n\n` +
          `Run \`${BIN} accounts list\` to see enrolled accounts, or use --all.`,
      );
    } else {
      printError(
        `Selector ${JSON.stringify(selector)} is ambiguous — it matches: ` +
          `${matches.map((m) => m.meta.key).join(", ")}.\n\nUse a more specific key or email.`,
      );
    }
    return 1;
  }

  const { removed, newActiveKey } = await removeAccount(record.meta.key);
  if (!removed) {
    printError(`Failed to remove account ${record.meta.key}.`);
    return 1;
  }
  process.stderr.write(
    `Logged out ${record.meta.email ?? record.meta.key} [${record.meta.key}].\n`,
  );
  if (newActiveKey) {
    process.stderr.write(`Active account is now [${newActiveKey}].\n`);
  }
  return 0;
}
