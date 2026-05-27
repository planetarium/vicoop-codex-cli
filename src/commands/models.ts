import { NotAuthenticatedError } from "../auth/manager.js";
import {
  CODEX_BACKEND_CLIENT_VERSION,
  fetchCodexModels,
} from "../client/models.js";
import {
  formatNetworkError,
  formatNotAuthenticated,
  printError,
} from "../cli/help-errors.js";

export interface ModelsCmdOptions {
  json: boolean;
}

export async function modelsCommand(opts: ModelsCmdOptions): Promise<number> {
  try {
    const result = await fetchCodexModels();
    if (opts.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      return 0;
    }

    process.stdout.write(`client_version: ${result.client_version}\n`);
    if (result.etag) process.stdout.write(`etag:           ${result.etag}\n`);
    process.stdout.write("models:\n");
    for (const model of result.models) {
      process.stdout.write(`  - ${model.id}\n`);
    }
    return 0;
  } catch (err) {
    if (err instanceof NotAuthenticatedError) {
      printError(formatNotAuthenticated());
      return 3;
    }
    if (err instanceof TypeError || (err as { code?: string })?.code === "ENOTFOUND") {
      printError(formatNetworkError(err));
      return 5;
    }
    printError(
      `${(err as Error).message ?? String(err)}\n\n` +
        `Models lookup uses Codex backend client_version ${CODEX_BACKEND_CLIENT_VERSION}.`,
    );
    return 4;
  }
}
