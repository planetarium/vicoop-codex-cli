import { ID_TOKEN_AUTH_CLAIM } from "./constants.js";

export interface JwtPayload {
  exp?: number;
  iat?: number;
  email?: string;
  [key: string]: unknown;
}

export interface ChatGptAuthClaims {
  chatgpt_plan_type?: string;
  chatgpt_user_id?: string;
  chatgpt_account_id?: string;
  chatgpt_account_is_fedramp?: boolean;
  organization_id?: string;
  project_id?: string;
}

export function decodeJwt(token: string): JwtPayload {
  const parts = token.split(".");
  if (parts.length < 2) {
    throw new Error("invalid JWT: expected at least 2 segments");
  }
  const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
  const json = Buffer.from(padded, "base64").toString("utf8");
  return JSON.parse(json) as JwtPayload;
}

export function extractChatGptClaims(idToken: string): ChatGptAuthClaims {
  const payload = decodeJwt(idToken);
  const auth = payload[ID_TOKEN_AUTH_CLAIM];
  if (auth && typeof auth === "object") {
    return auth as ChatGptAuthClaims;
  }
  return {};
}

export function extractAccountId(idToken: string): string | undefined {
  return extractChatGptClaims(idToken).chatgpt_account_id;
}

export function isExpired(token: string, skewSeconds = 60): boolean {
  try {
    const payload = decodeJwt(token);
    if (typeof payload.exp !== "number") return false;
    const nowSec = Math.floor(Date.now() / 1000);
    return payload.exp - skewSeconds <= nowSec;
  } catch {
    return true;
  }
}
