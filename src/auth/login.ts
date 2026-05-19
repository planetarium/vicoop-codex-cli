import {
  AUTHORIZE_URL,
  CLIENT_ID,
  SCOPES,
} from "./constants.js";
import { generatePkcePair, generateState } from "./pkce.js";
import { startCallbackServer } from "./server.js";
import { exchangeAuthCode } from "./oauth.js";
import { extractAccountId } from "./jwt.js";
import { writeAuth, type AuthFile } from "./store.js";

export interface LoginOptions {
  /** If true, do not attempt to open the browser automatically. */
  noBrowser?: boolean;
  /** Override host for the auth server (e.g. for testing). */
  authHost?: string;
}

function buildAuthorizeUrl(opts: {
  redirectUri: string;
  state: string;
  codeChallenge: string;
  authHost?: string;
}): string {
  const base = opts.authHost ?? AUTHORIZE_URL;
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: opts.redirectUri,
    scope: SCOPES,
    state: opts.state,
    code_challenge: opts.codeChallenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
  });
  return `${base}?${params.toString()}`;
}

async function openInBrowser(url: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  const platform = process.platform;
  let cmd: string;
  let args: string[];
  if (platform === "darwin") {
    cmd = "open";
    args = [url];
  } else if (platform === "win32") {
    cmd = "cmd";
    args = ["/c", "start", "", url];
  } else {
    cmd = "xdg-open";
    args = [url];
  }
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {
      // best-effort; user can still copy-paste the URL
    });
    child.unref();
  } catch {
    // ignore — fall back to printing the URL
  }
}

export async function runLogin(options: LoginOptions = {}): Promise<AuthFile> {
  const { codeVerifier, codeChallenge } = generatePkcePair();
  const state = generateState();

  const server = await startCallbackServer();
  try {
    const authorizeUrl = buildAuthorizeUrl({
      redirectUri: server.redirectUri,
      state,
      codeChallenge,
      authHost: options.authHost,
    });

    process.stderr.write(`\nOpen this URL in your browser to sign in with ChatGPT:\n  ${authorizeUrl}\n\n`);
    if (!options.noBrowser) {
      await openInBrowser(authorizeUrl);
    }
    process.stderr.write(`Waiting for callback on ${server.redirectUri} …\n`);

    const callback = await server.waitForCallback(state);
    const tokens = await exchangeAuthCode({
      code: callback.code,
      redirectUri: server.redirectUri,
      codeVerifier,
    });
    const accountId = extractAccountId(tokens.idToken);

    const authFile: AuthFile = {
      auth_mode: "chatgpt",
      tokens: {
        id_token: tokens.idToken,
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        account_id: accountId,
      },
      last_refresh: new Date().toISOString(),
    };
    await writeAuth(authFile);
    process.stderr.write("Login successful.\n");
    return authFile;
  } finally {
    server.close();
  }
}
