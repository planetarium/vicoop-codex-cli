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
