import { runResponse, ApiError, type ReasoningEffort } from "../client/responses.js";
import { NotAuthenticatedError } from "../auth/manager.js";
import { tryListModelIds } from "../client/models.js";
import {
  formatApiError,
  formatMissingModelPrompt,
  formatMissingPrompt,
  formatNetworkError,
  formatNotAuthenticated,
  formatStreamError,
  printError,
} from "../cli/help-errors.js";

export interface PromptCmdOptions {
  prompt: string;
  model?: string;
  instructions?: string;
  reasoning?: ReasoningEffort;
  stream: boolean;
  json: boolean;
}

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

export async function promptCommand(opts: PromptCmdOptions): Promise<number> {
  let prompt = opts.prompt;
  const piped = await readStdin();
  if (piped.length > 0) {
    prompt = prompt.length > 0 ? `${prompt}\n\n${piped}` : piped;
  }
  if (prompt.trim().length === 0) {
    printError(formatMissingPrompt());
    return 2;
  }

  const model = opts.model?.trim();
  if (!model) {
    printError(formatMissingModelPrompt(await tryListModelIds()));
    return 2;
  }

  try {
    const result = await runResponse(
      {
        prompt,
        model,
        instructions: opts.instructions,
        reasoningEffort: opts.reasoning,
      },
      {
        onTextDelta: opts.stream && !opts.json
          ? (delta) => process.stdout.write(delta)
          : undefined,
      },
    );

    if (opts.json) {
      process.stdout.write(
        JSON.stringify(
          {
            text: result.text,
            response_id: result.responseId,
            usage: result.usage,
            model: result.model,
          },
          null,
          2,
        ) + "\n",
      );
    } else if (!opts.stream) {
      process.stdout.write(result.text);
      if (!result.text.endsWith("\n")) process.stdout.write("\n");
    } else {
      if (!result.text.endsWith("\n")) process.stdout.write("\n");
    }
    return 0;
  } catch (err) {
    if (err instanceof NotAuthenticatedError) {
      printError(formatNotAuthenticated());
      return 3;
    }
    if (err instanceof ApiError) {
      if (err.status === 0) {
        // ApiError(status=0) is thrown for in-stream `response.failed`/`error`.
        printError(formatStreamError(err.message));
        return 4;
      }
      printError(formatApiError(err.status, err.detail ?? err.message));
      return 4;
    }
    if (err instanceof TypeError || (err as { code?: string })?.code === "ENOTFOUND") {
      printError(formatNetworkError(err));
      return 5;
    }
    printError(`${(err as Error).message ?? String(err)}`);
    return 1;
  }
}
