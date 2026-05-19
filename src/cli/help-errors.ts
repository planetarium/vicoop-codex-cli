/**
 * User-friendly error formatters for CLI subcommands.
 * Each formatter returns a multi-line string ready to write to stderr.
 *
 * Goals:
 * - State what went wrong in one line at the top.
 * - Show the exact command(s) to fix it.
 * - Keep the raw backend detail at the bottom for debugging.
 */

const BIN = "vicoop-codex";

export function formatNotAuthenticated(): string {
  return [
    "Not signed in.",
    "",
    "Sign in with your ChatGPT account first:",
    `  $ ${BIN} login`,
    "",
    "If a browser doesn't open automatically, use --no-browser to get a URL to copy:",
    `  $ ${BIN} login --no-browser`,
  ].join("\n");
}

export function formatMissingPrompt(): string {
  return [
    "No prompt provided.",
    "",
    "Usage:",
    `  $ ${BIN} prompt "your question here"`,
    `  $ echo "summarize this file" | ${BIN} prompt`,
    "",
    "With options:",
    `  $ ${BIN} prompt -m gpt-5.3-codex -r high "explain monads"`,
    `  $ ${BIN} prompt -i "Reply in Korean only." "지구의 둘레는?"`,
  ].join("\n");
}

export function formatNoBody(): string {
  return [
    "No request body provided.",
    "",
    "Usage:",
    `  $ ${BIN} call '{"messages":[{"role":"user","content":"hi"}]}'`,
    `  $ echo '<body json>' | ${BIN} call`,
    `  $ cat body.json | ${BIN} call`,
  ].join("\n");
}

export function formatJsonParseError(err: unknown): string {
  return [
    `Invalid JSON body: ${(err as Error).message ?? String(err)}`,
    "",
    "Example of a valid request body:",
    "  {",
    '    "model": "gpt-5.3-codex",',
    '    "messages": [',
    '      { "role": "user", "content": "hello" }',
    "    ]",
    "  }",
    "",
    `Then call as:`,
    `  $ ${BIN} call '<that JSON on one line>'`,
  ].join("\n");
}

export function formatMissingMessages(): string {
  return [
    "'messages' is required and must be a non-empty array.",
    "",
    "Add at least one user message:",
    `  $ ${BIN} call '{"messages":[{"role":"user","content":"hi"}]}'`,
    "",
    "Or with a system instruction:",
    `  $ ${BIN} call '{"messages":[`,
    `      {"role":"system","content":"Be terse."},`,
    `      {"role":"user","content":"hi"}`,
    `    ]}'`,
  ].join("\n");
}

export function formatNotSignedInWhoami(): string {
  return [
    "Not signed in — there are no credentials to show.",
    "",
    "Sign in first:",
    `  $ ${BIN} login`,
  ].join("\n");
}

export function formatNetworkError(err: unknown): string {
  return [
    `Failed to reach the ChatGPT backend: ${(err as Error).message ?? String(err)}`,
    "",
    "Things to check:",
    "  • Your internet connection.",
    "  • Whether `https://chatgpt.com/` is reachable from this machine.",
    "  • If you're behind a corporate proxy/firewall, ChatGPT may be blocked.",
  ].join("\n");
}

/**
 * Format an HTTP-level API error from the ChatGPT Codex backend.
 * Recognises common error patterns and provides actionable guidance.
 */
export function formatApiError(status: number, detail: string | undefined): string {
  const raw = detail ?? "";
  const lower = raw.toLowerCase();

  if (lower.includes("not supported when using codex with a chatgpt account")) {
    return [
      `ChatGPT Codex backend rejected the request (HTTP ${status}).`,
      "",
      "This usually means one of two things:",
      "  1) The model name you sent isn't on the current Codex model list, OR",
      "  2) Your ChatGPT plan doesn't include Codex access.",
      "",
      "Check your plan first:",
      `  $ ${BIN} whoami      # look at the "plan:" line — needs plus / pro / team / enterprise`,
      "",
      "If the plan is fine, try a valid model slug (current set, may change over time):",
      "  -m gpt-5.5   -m gpt-5.4   -m gpt-5.4-mini   -m gpt-5.3-codex   -m gpt-5.2",
      "",
      `Example:`,
      `  $ ${BIN} prompt -m gpt-5.3-codex "hi"`,
      "",
      `Raw response: ${raw}`,
    ].join("\n");
  }

  if (lower.includes("instructions are required")) {
    return [
      `Missing required field 'instructions' (HTTP ${status}).`,
      "",
      "The ChatGPT Codex backend won't accept a request without system instructions.",
      "",
      "For `prompt`, pass them with -i:",
      `  $ ${BIN} prompt -i "You are a helpful assistant." "hello"`,
      "",
      "For `call`/`serve`, include a system or developer message in the messages array:",
      `  { "messages": [`,
      `      { "role": "system", "content": "You are a helpful assistant." },`,
      `      { "role": "user",   "content": "hello" }`,
      `    ] }`,
      "",
      `Raw response: ${raw}`,
    ].join("\n");
  }

  const unsupportedMatch = raw.match(/Unsupported parameter:\s*([\w_.-]+)/i);
  if (unsupportedMatch) {
    const param = unsupportedMatch[1];
    return [
      `ChatGPT Codex backend doesn't accept the parameter '${param}' (HTTP ${status}).`,
      "",
      "Only a narrow set of body fields is accepted upstream. Common ones the backend rejects:",
      "  max_tokens / max_completion_tokens, temperature, top_p, n, seed, stop,",
      "  frequency_penalty, presence_penalty, logprobs, top_logprobs, logit_bias,",
      "  response_format, service_tier, user, metadata",
      "",
      `If you used \`${BIN} call\` or hit POST /v1/chat/completions, these are normally dropped`,
      "automatically. Remove the field from your request and retry.",
      "",
      `Raw response: ${raw}`,
    ].join("\n");
  }

  if (status === 401) {
    return [
      `ChatGPT rejected your credentials (HTTP 401).`,
      "",
      "Your access token may be revoked or expired. Re-authenticate:",
      `  $ ${BIN} logout`,
      `  $ ${BIN} login`,
      "",
      `Raw response: ${raw}`,
    ].join("\n");
  }

  if (status === 403) {
    return [
      `Permission denied (HTTP 403).`,
      "",
      "Your ChatGPT plan likely doesn't include Codex access. Codex requires Plus or higher.",
      "",
      "Check your plan:",
      `  $ ${BIN} whoami`,
      "",
      "If you recently upgraded but the plan still shows the old tier, force a token refresh:",
      `  $ ${BIN} logout && ${BIN} login`,
      "",
      `Raw response: ${raw}`,
    ].join("\n");
  }

  if (status === 429) {
    return [
      `Rate limit reached (HTTP 429).`,
      "",
      "You've hit the per-window quota for your ChatGPT plan. Try one of:",
      "  • Wait a few minutes for the window to reset.",
      "  • Reduce request frequency.",
      "  • Upgrade your ChatGPT plan for a higher quota.",
      "",
      `Raw response: ${raw}`,
    ].join("\n");
  }

  if (status >= 500) {
    return [
      `ChatGPT backend returned a server error (HTTP ${status}).`,
      "",
      "This is usually temporary — wait a moment and retry.",
      "If it persists, the backend may be down. Check https://status.openai.com/ for incidents.",
      "",
      `Raw response: ${raw}`,
    ].join("\n");
  }

  return [
    `ChatGPT backend returned HTTP ${status}.`,
    raw ? `Raw response: ${raw}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatStreamError(message: string): string {
  return [
    `Upstream stream ended with a failure: ${message}`,
    "",
    "This is usually a transient backend issue. Retry the request.",
    "If it keeps happening on the same prompt, try with a smaller / simpler prompt to isolate.",
  ].join("\n");
}

/**
 * Print a formatted error to stderr with a trailing newline.
 */
export function printError(formatted: string): void {
  process.stderr.write(`Error: ${formatted}\n`);
}
