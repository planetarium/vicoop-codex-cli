import { postUpstream } from "../client/responses.js";
import { NotAuthenticatedError } from "../auth/manager.js";
import { tryListModelIds } from "../client/models.js";
import {
  chatCompletionsToUpstream,
  collectChatCompletion,
  type ChatCompletionsBody,
} from "../translate/chat-completions.js";
import {
  formatApiError,
  formatJsonParseError,
  formatMissingMessages,
  formatMissingModelBody,
  formatNetworkError,
  formatNoBody,
  formatNotAuthenticated,
  printError,
} from "../cli/help-errors.js";

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c) => chunks.push(c as Buffer));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

export async function callCommand(arg: string | undefined): Promise<number> {
  let raw = (arg ?? "").trim();
  if (raw.length === 0) raw = (await readStdin()).trim();
  if (raw.length === 0) {
    printError(formatNoBody());
    return 2;
  }

  let body: ChatCompletionsBody;
  try {
    body = JSON.parse(raw) as ChatCompletionsBody;
  } catch (err) {
    printError(formatJsonParseError(err));
    return 2;
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    printError(formatMissingMessages());
    return 2;
  }

  const requestedModel =
    typeof body.model === "string" ? body.model.trim() : undefined;
  if (!requestedModel) {
    printError(formatMissingModelBody(await tryListModelIds()));
    return 2;
  }
  body.model = requestedModel;
  const { upstream, dropped } = chatCompletionsToUpstream(body);
  if (dropped.length > 0) {
    process.stderr.write(`note: dropped unsupported fields: ${dropped.join(", ")}\n`);
  }

  let upstreamRes: Response;
  try {
    upstreamRes = await postUpstream(upstream);
  } catch (err) {
    if (err instanceof NotAuthenticatedError) {
      printError(formatNotAuthenticated());
      return 3;
    }
    if (err instanceof TypeError || (err as { code?: string })?.code === "ENOTFOUND") {
      printError(formatNetworkError(err));
      return 5;
    }
    printError(`upstream fetch failed: ${(err as Error).message ?? String(err)}`);
    return 4;
  }

  const result = await collectChatCompletion(upstreamRes, requestedModel);
  if ("error" in result) {
    printError(formatApiError(result.error.status, result.error.message));
    return 4;
  }

  process.stdout.write(JSON.stringify(result.ok, null, 2) + "\n");
  return 0;
}
