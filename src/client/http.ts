import { Agent, type Dispatcher } from "undici";

/**
 * Node's global `fetch` (powered by undici) applies a default `bodyTimeout` of
 * 300_000 ms (5 minutes): if the upstream sends no body bytes for five minutes
 * it aborts the request with a "terminated" / "operation timed out" error. The
 * ChatGPT `/responses` SSE stream can stay completely silent for several
 * minutes while a reasoning model thinks before emitting its first delta, so
 * that default cuts long reasoning requests off mid-flight (observed as
 * "serve stream interrupted: The operation timed out" on the bridge client).
 *
 * We therefore route Codex backend calls through a dedicated dispatcher with
 * the inter-chunk idle timer disabled (`bodyTimeout: 0`). A non-zero
 * `headersTimeout` is kept so a connection that never produces *any* response
 * still fails fast, and the overall ceiling is enforced separately by an
 * explicit AbortSignal deadline on the streaming request (see
 * `responses.ts#withDeadline`).
 */
let dispatcher: Agent | undefined;

export function codexDispatcher(): Dispatcher {
  if (!dispatcher) {
    dispatcher = new Agent({
      // 0 disables undici's inter-chunk idle timer — long silent reasoning
      // gaps no longer abort the stream; the absolute deadline guards runaway.
      bodyTimeout: 0,
      // Response headers (200 + text/event-stream) arrive promptly even for
      // reasoning requests, so keep a finite guard against a dead connection.
      headersTimeout: 120_000,
      keepAliveTimeout: 60_000,
      keepAliveMaxTimeout: 600_000,
    });
  }
  return dispatcher;
}
