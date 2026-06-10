export const OPENAI_AUTH_ISSUER = "https://auth.openai.com";
export const AUTHORIZE_URL = `${OPENAI_AUTH_ISSUER}/oauth/authorize`;
export const TOKEN_URL = `${OPENAI_AUTH_ISSUER}/oauth/token`;
export const REVOKE_URL = `${OPENAI_AUTH_ISSUER}/oauth/revoke`;

export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

export const SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "api.connectors.read",
  "api.connectors.invoke",
].join(" ");

export const DEFAULT_LOCAL_PORT = 1455;
export const FALLBACK_LOCAL_PORT = 1457;
export const REDIRECT_PATH = "/auth/callback";

export const ID_TOKEN_AUTH_CLAIM = "https://api.openai.com/auth";

// --- Device-code (device authorization) flow ---------------------------------
//
// NOTE: This is NOT RFC 8628 / Auth0 `/oauth/device/code`. OpenAI's Codex device
// flow is a proprietary flow under `/api/accounts/deviceauth/*`:
//   1. POST .../usercode  → { device_auth_id, user_code, interval }
//   2. user enters `user_code` at DEVICE_AUTH_VERIFICATION_URL
//   3. POST .../token (polled) → { authorization_code, code_verifier }
//   4. exchange that authorization_code at TOKEN_URL via PKCE (grant_type=
//      authorization_code, redirect_uri=DEVICE_AUTH_REDIRECT_URI)
// Ported from openai/codex `codex-rs/login/src/device_code_auth.rs`.
export const DEVICE_AUTH_USERCODE_URL = `${OPENAI_AUTH_ISSUER}/api/accounts/deviceauth/usercode`;
export const DEVICE_AUTH_TOKEN_URL = `${OPENAI_AUTH_ISSUER}/api/accounts/deviceauth/token`;
export const DEVICE_AUTH_VERIFICATION_URL = `${OPENAI_AUTH_ISSUER}/codex/device`;
export const DEVICE_AUTH_REDIRECT_URI = `${OPENAI_AUTH_ISSUER}/deviceauth/callback`;

/** The device user code is valid for 15 minutes server-side. */
export const DEVICE_AUTH_TIMEOUT_MS = 15 * 60 * 1000;
/** Default poll interval if the server doesn't advertise an `interval`. */
export const DEVICE_AUTH_DEFAULT_INTERVAL_SECONDS = 5;
