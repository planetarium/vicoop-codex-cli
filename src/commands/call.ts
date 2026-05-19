import { postUpstream } from "../client/responses.js";
import { NotAuthenticatedError } from "../auth/manager.js";
import {
  DEFAULT_MODEL,
  chatCompletionsToUpstream,
  collectChatCompletion,
  type ChatCompletionsBody,
} from "../translate/chat-completions.js";

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
    process.stderr.write(
      "Error: provide the Chat Completions request body as a JSON argument or via stdin.\n",
    );
    return 2;
  }

  let body: ChatCompletionsBody;
  try {
    body = JSON.parse(raw) as ChatCompletionsBody;
  } catch (err) {
    process.stderr.write(`Invalid JSON: ${(err as Error).message}\n`);
    return 2;
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    process.stderr.write("'messages' is required and must be a non-empty array.\n");
    return 2;
  }

  const requestedModel = body.model ?? DEFAULT_MODEL;
  const { upstream, dropped } = chatCompletionsToUpstream(body);
  if (dropped.length > 0) {
    process.stderr.write(`dropped unsupported fields: ${dropped.join(", ")}\n`);
  }

  let upstreamRes: Response;
  try {
    upstreamRes = await postUpstream(upstream);
  } catch (err) {
    if (err instanceof NotAuthenticatedError) {
      process.stderr.write(`${err.message}\n`);
      return 3;
    }
    process.stderr.write(`upstream fetch failed: ${(err as Error).message ?? String(err)}\n`);
    return 4;
  }

  const result = await collectChatCompletion(upstreamRes, requestedModel);
  if ("error" in result) {
    process.stderr.write(`upstream HTTP ${result.error.status}: ${result.error.message}\n`);
    return 4;
  }

  process.stdout.write(JSON.stringify(result.ok, null, 2) + "\n");
  return 0;
}
