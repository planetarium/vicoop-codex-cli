import { isExpired, extractAccountId } from "./jwt.js";
import { refreshTokens } from "./oauth.js";
import { readAuth, writeAuth, type AuthFile } from "./store.js";

export class NotAuthenticatedError extends Error {
  constructor() {
    super("Not signed in. Run `vicoop-codex login` first.");
    this.name = "NotAuthenticatedError";
  }
}

export interface ActiveAuth {
  accessToken: string;
  accountId?: string;
}

async function refreshAndPersist(auth: AuthFile): Promise<AuthFile> {
  const refreshed = await refreshTokens(auth.tokens.refresh_token);
  const idToken = refreshed.idToken ?? auth.tokens.id_token;
  const accountId = refreshed.idToken
    ? extractAccountId(refreshed.idToken) ?? auth.tokens.account_id
    : auth.tokens.account_id;
  const next: AuthFile = {
    ...auth,
    tokens: {
      id_token: idToken,
      access_token: refreshed.accessToken,
      refresh_token: refreshed.refreshToken,
      account_id: accountId,
    },
    last_refresh: new Date().toISOString(),
  };
  await writeAuth(next);
  return next;
}

/** Load auth and refresh proactively if the access_token is about to expire. */
export async function loadActiveAuth(): Promise<ActiveAuth> {
  const auth = await readAuth();
  if (!auth) throw new NotAuthenticatedError();
  const current = isExpired(auth.tokens.access_token, 60)
    ? await refreshAndPersist(auth)
    : auth;
  return {
    accessToken: current.tokens.access_token,
    accountId: current.tokens.account_id,
  };
}

/** Force a refresh — used after a 401 from the API. */
export async function forceRefresh(): Promise<ActiveAuth> {
  const auth = await readAuth();
  if (!auth) throw new NotAuthenticatedError();
  const next = await refreshAndPersist(auth);
  return {
    accessToken: next.tokens.access_token,
    accountId: next.tokens.account_id,
  };
}
