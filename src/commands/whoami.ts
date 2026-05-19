import { readAuth } from "../auth/store.js";
import { decodeJwt, extractChatGptClaims } from "../auth/jwt.js";
import { formatNotSignedInWhoami, printError } from "../cli/help-errors.js";

export async function whoamiCommand(json: boolean): Promise<number> {
  const auth = await readAuth();
  if (!auth) {
    printError(formatNotSignedInWhoami());
    return 1;
  }
  const payload = decodeJwt(auth.tokens.id_token);
  const claims = extractChatGptClaims(auth.tokens.id_token);
  const info = {
    email: (payload.email as string | undefined) ?? null,
    chatgpt_plan_type: claims.chatgpt_plan_type ?? null,
    chatgpt_account_id: claims.chatgpt_account_id ?? null,
    chatgpt_user_id: claims.chatgpt_user_id ?? null,
    last_refresh: auth.last_refresh,
  };
  if (json) {
    process.stdout.write(JSON.stringify(info, null, 2) + "\n");
  } else {
    process.stdout.write(
      `email:        ${info.email ?? "(unknown)"}\n` +
        `plan:         ${info.chatgpt_plan_type ?? "(unknown)"}\n` +
        `account id:   ${info.chatgpt_account_id ?? "(unknown)"}\n` +
        `user id:      ${info.chatgpt_user_id ?? "(unknown)"}\n` +
        `last refresh: ${info.last_refresh}\n`,
    );
  }
  return 0;
}
