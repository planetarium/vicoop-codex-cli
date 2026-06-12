import { Command, Option } from "commander";
import { callCommand } from "./commands/call.js";
import { loginCommand } from "./commands/login.js";
import { logoutCommand } from "./commands/logout.js";
import { modelsCommand } from "./commands/models.js";
import { promptCommand } from "./commands/prompt.js";
import { serveCommand } from "./commands/serve.js";
import { upgradeCommand } from "./commands/upgrade.js";
import { whoamiCommand } from "./commands/whoami.js";
import {
  accountsAddCommand,
  accountsListCommand,
  accountsSetEnabledCommand,
  accountsStrategyCommand,
  accountsUsageCommand,
  accountsUseCommand,
} from "./commands/accounts.js";
import type { ReasoningEffort } from "./client/responses.js";

export const VERSION = "0.1.0";

interface PromptOptions {
  model?: string;
  instructions?: string;
  reasoning?: ReasoningEffort;
  stream: boolean;
  json?: boolean;
}

interface LoginOptions {
  browser: boolean;
  deviceCode?: boolean;
}

interface WhoamiOptions {
  json?: boolean;
}

interface LogoutOptions {
  account?: string;
  all?: boolean;
}

interface AccountsListOpts {
  json?: boolean;
}

interface AccountsAddOpts {
  deviceCode?: boolean;
  browser: boolean;
  activate: boolean;
}

interface ModelsOptions {
  json?: boolean;
}

interface ServeOptions {
  port: string;
  host: string;
  defaultModel?: string;
}

interface UpgradeOptions {
  check?: boolean;
  force?: boolean;
}

export async function main(): Promise<void> {
  const program = new Command();

  program
    .name("vicoop-codex")
    .description(
      "Lightweight Codex CLI that calls the ChatGPT LLM via your subscription.",
    )
    .version(VERSION, "-v, --version", "Show the version.")
    .helpOption("-h, --help", "Show this help.")
    .showHelpAfterError("(run with --help for usage)")
    .showSuggestionAfterError(true)
    .addHelpText(
      "after",
      `
Environment:
  VICOOP_CODEX_HOME              Override the credentials directory (default: ~/.vicoop-codex)
  VICOOP_CODEX_ACCOUNT_STRATEGY  Multi-account selection strategy (default: random; see \`accounts\`)

Examples:
  $ vicoop-codex models                                  # list models you can use
  $ vicoop-codex prompt -m gpt-5.5 "Explain monads in one paragraph"
  $ echo "summarize this file" | vicoop-codex prompt -m gpt-5.5
  $ vicoop-codex prompt -m gpt-5.5 --json "give me a haiku" > out.json`,
    );

  program
    .command("prompt [text...]")
    .description("Send a one-shot prompt.")
    .option("-m, --model <name>", "Model id (required — run `vicoop-codex models` to list)")
    .option("-i, --instructions <text>", "System-style instructions")
    .addOption(
      new Option(
        "-r, --reasoning <effort>",
        "Reasoning effort (default: medium server-side)",
      ).choices(["low", "medium", "high"]),
    )
    .option("--no-stream", "Buffer the whole response, print at the end")
    .option("--json", "Print JSON { text, response_id, usage, model }")
    .action(async (text: string[] | undefined, options: PromptOptions) => {
      const promptText = (text ?? []).join(" ");
      const code = await promptCommand({
        prompt: promptText,
        model: options.model,
        instructions: options.instructions,
        reasoning: options.reasoning,
        stream: options.stream,
        json: options.json === true,
      });
      process.exit(code);
    });

  program
    .command("login")
    .description("Sign in to ChatGPT via OAuth (PKCE loopback, or --device-code).")
    .option("--no-browser", "Don't try to open a browser automatically")
    .option(
      "--device-code",
      "Use OpenAI's device-code flow: print a URL + one-time code to enter in any browser (for headless/remote machines; requires device-code login enabled on your OpenAI account)",
    )
    .action(async (options: LoginOptions) => {
      const code = await loginCommand({
        noBrowser: !options.browser,
        deviceCode: options.deviceCode === true,
      });
      process.exit(code);
    });

  program
    .command("logout")
    .description(
      "Remove stored credentials for an account (--account <id>) or all accounts (--all).",
    )
    .option(
      "-a, --account <id>",
      "Email or account key to log out (run `vicoop-codex accounts list`)",
    )
    .option("--all", "Log out every enrolled account")
    .action(async (options: LogoutOptions) => {
      const code = await logoutCommand({
        account: options.account,
        all: options.all === true,
      });
      process.exit(code);
    });

  program
    .command("whoami")
    .description("Show the signed-in account.")
    .option("--json", "Output as JSON")
    .action(async (options: WhoamiOptions) => {
      const code = await whoamiCommand(options.json === true);
      process.exit(code);
    });

  const accounts = program
    .command("accounts")
    .description(
      "Manage multiple ChatGPT accounts. Calls pick one available account (default: random) and fall back to another on failure.",
    )
    .addHelpText(
      "after",
      `
The active account is mirrored into auth.json so 'whoami'/'login'/'serve' keep
working unchanged. Selection strategy can also be set via the
VICOOP_CODEX_ACCOUNT_STRATEGY environment variable.

Examples:
  $ vicoop-codex accounts add                 # enroll another account
  $ vicoop-codex accounts list                # show all enrolled accounts
  $ vicoop-codex accounts use alice@corp.com  # set the active account
  $ vicoop-codex accounts disable <key>       # exclude one from selection`,
    );

  accounts
    .command("list")
    .description("List enrolled accounts and the active selection strategy.")
    .option("--json", "Output as JSON")
    .action(async (options: AccountsListOpts) => {
      const code = await accountsListCommand({ json: options.json === true });
      process.exit(code);
    });

  accounts
    .command("add")
    .description("Enroll an additional ChatGPT account (same OAuth flow as `login`).")
    .option("--no-browser", "Don't try to open a browser automatically")
    .option("--device-code", "Use the device-code flow (headless/remote machines)")
    .option("--no-activate", "Enroll without making it the active account")
    .action(async (options: AccountsAddOpts) => {
      const code = await accountsAddCommand({
        deviceCode: options.deviceCode === true,
        noBrowser: !options.browser,
        activate: options.activate !== false,
      });
      process.exit(code);
    });

  accounts
    .command("use <account>")
    .description("Set the active account (email or key).")
    .action(async (account: string) => {
      const code = await accountsUseCommand(account);
      process.exit(code);
    });

  accounts
    .command("enable <account>")
    .description("Include an account in automatic selection.")
    .action(async (account: string) => {
      const code = await accountsSetEnabledCommand(account, true);
      process.exit(code);
    });

  accounts
    .command("disable <account>")
    .description("Exclude an account from automatic selection.")
    .action(async (account: string) => {
      const code = await accountsSetEnabledCommand(account, false);
      process.exit(code);
    });

  accounts
    .command("strategy [name]")
    .description("Show or set the account-selection strategy (default: random).")
    .action(async (name: string | undefined) => {
      const code = await accountsStrategyCommand(name);
      process.exit(code);
    });

  accounts
    .command("usage [account]")
    .description("Show remaining Codex usage per account (5h + weekly windows). Omit [account] for all.")
    .option("--json", "Output as JSON")
    .action(async (account: string | undefined, options: AccountsListOpts) => {
      const code = await accountsUsageCommand({
        json: options.json === true,
        selector: account,
      });
      process.exit(code);
    });

  program
    .command("models")
    .description("List ChatGPT Codex backend models available to this account.")
    .option("--json", "Output JSON { client_version, etag, models }")
    .action(async (options: ModelsOptions) => {
      const code = await modelsCommand({ json: options.json === true });
      process.exit(code);
    });

  program
    .command("call [body]")
    .description(
      "Send a Chat Completions request body (JSON) through the same translation pipeline as the server and print the response JSON.",
    )
    .action(async (body: string | undefined) => {
      const code = await callCommand(body);
      process.exit(code);
    });

  program
    .command("serve")
    .description(
      "Run a local HTTP server that exposes POST /v1/chat/completions (OpenAI Chat Completions shape) and an A2A endpoint, backed by your ChatGPT OAuth.",
    )
    .option("-p, --port <n>", "Port to bind (0 = random ephemeral; default: 8787)", "8787")
    .option("-H, --host <ip>", "Host/IP to bind (default: 127.0.0.1)", "127.0.0.1")
    .option(
      "-d, --default-model <name>",
      "Model for requests that omit one. Validated at startup; self-heals to a live model if unset/unavailable.",
    )
    .action(async (options: ServeOptions) => {
      const port = Number(options.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        process.stderr.write(`Invalid port: ${options.port}\n`);
        process.exit(2);
        return;
      }
      const code = await serveCommand({
        port,
        host: options.host,
        defaultModel: options.defaultModel,
      });
      process.exit(code);
    });

  program
    .command("upgrade")
    .description(
      "Self-update the standalone binary to the latest GitHub release (verifies SHA256).",
    )
    .option("--check", "Only report whether a newer version is available; don't install")
    .option("--force", "Re-download and reinstall even if already up to date")
    .action(async (options: UpgradeOptions) => {
      const code = await upgradeCommand({
        check: options.check === true,
        force: options.force === true,
      });
      process.exit(code);
    });

  if (process.argv.length <= 2) {
    program.outputHelp();
    return;
  }

  await program.parseAsync(process.argv);
}
