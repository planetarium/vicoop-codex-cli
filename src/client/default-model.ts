import { tryListModelIds } from "./models.js";

/**
 * Self-healing default model for `serve`'s OpenAI Chat Completions endpoint.
 * The `serve` command seeds it at startup (from `--default-model`, or by
 * auto-selecting the first advertised model). Requests that omit `model` fall
 * back to it, and it re-resolves when the backend reports the current default
 * unavailable — adopting the first advertised id that hasn't been rejected, so
 * a retired list-head can't trap the server on a permanently-failing model.
 */
let current: string | undefined;
let resolvePending: Promise<{ model: string | null; ids: string[] | null }> | null = null;
const rejected = new Set<string>();

export function getDefaultModel(): string | undefined {
  return current;
}

export function setDefaultModel(model: string | undefined): void {
  const trimmed = model?.trim();
  current = trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/** Reset all state. Called at `serve` startup so a re-run begins clean. */
export function resetDefaultModelState(): void {
  current = undefined;
  resolvePending = null;
  rejected.clear();
}

/** Mark a model id as rejected so future resolution skips it. */
export function markModelRejected(model: string): void {
  rejected.add(model);
}

/** Recognise the backend's "this model isn't usable on a ChatGPT account" 400. */
export function isModelUnsupportedError(status: number, detail: string): boolean {
  return (
    status === 400 &&
    /not supported when using codex with a chatgpt account/i.test(detail)
  );
}

/**
 * Re-resolve the default from the live `/models` list, adopting the first id
 * not in the rejected set. Concurrent callers share a single in-flight fetch.
 * Returns the adopted model (or null if none usable) plus the ids list it saw
 * (so callers can reuse it for an error message without re-fetching).
 */
export async function resolveDefaultModel(
  reason: string,
): Promise<{ model: string | null; ids: string[] | null }> {
  if (!resolvePending) {
    resolvePending = (async () => {
      const ids = await tryListModelIds();
      const pick = ids?.find((id) => !rejected.has(id)) ?? null;
      if (pick) {
        current = pick;
        process.stderr.write(
          `[default-model] resolved to ${JSON.stringify(pick)} (${reason})\n`,
        );
      }
      return { model: pick, ids };
    })();
    void resolvePending.finally(() => {
      resolvePending = null;
    });
  }
  return resolvePending;
}
