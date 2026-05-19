import { CLIENT_ID, TOKEN_URL } from "./constants.js";

interface TokenResponse {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

async function postForm(
  url: string,
  form: Record<string, string>,
): Promise<TokenResponse> {
  const body = new URLSearchParams(form).toString();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });

  let parsed: TokenResponse = {};
  const text = await res.text();
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text) as TokenResponse;
    } catch {
      throw new Error(
        `Token endpoint returned non-JSON response (status ${res.status}): ${text.slice(0, 200)}`,
      );
    }
  }
  if (!res.ok || parsed.error) {
    const msg = parsed.error_description ?? parsed.error ?? `HTTP ${res.status}`;
    throw new Error(`Token endpoint error: ${msg}`);
  }
  return parsed;
}

export async function exchangeAuthCode(opts: {
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<{ idToken: string; accessToken: string; refreshToken: string }> {
  const res = await postForm(TOKEN_URL, {
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: CLIENT_ID,
    code_verifier: opts.codeVerifier,
  });
  if (!res.id_token || !res.access_token || !res.refresh_token) {
    throw new Error("Token endpoint response is missing id_token / access_token / refresh_token");
  }
  return {
    idToken: res.id_token,
    accessToken: res.access_token,
    refreshToken: res.refresh_token,
  };
}

export async function refreshTokens(refreshToken: string): Promise<{
  idToken?: string;
  accessToken: string;
  refreshToken: string;
}> {
  const res = await postForm(TOKEN_URL, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
    scope: "openid profile email",
  });
  if (!res.access_token) {
    throw new Error("Refresh response is missing access_token");
  }
  return {
    idToken: res.id_token,
    accessToken: res.access_token,
    refreshToken: res.refresh_token ?? refreshToken,
  };
}
