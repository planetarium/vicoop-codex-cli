import { Agent, type Dispatcher } from "undici";

/**
 * Node-runtime knob for the `/responses` idle timeout.
 *
 * Node's global `fetch` (powered by undici) applies a default `bodyTimeout` of
 * 300_000 ms (5 minutes): if the upstream sends no body bytes for five minutes
 * it aborts the request. The ChatGPT `/responses` SSE stream can stay silent
 * for several minutes while a reasoning model thinks before its first delta, so
 * that default cut long reasoning requests off mid-flight. We disable the
 * inter-chunk idle timer (`bodyTimeout: 0`) and keep a finite `headersTimeout`
 * so a connection that never produces *any* response still fails fast; the
 * overall ceiling is enforced separately by an explicit AbortSignal deadline
 * (`responses.ts#withDeadline`).
 *
 * NOTE: this only affects the Node runtime (source / npm installs). The
 * compiled release binaries run on **Bun**, whose `fetch` ignores undici's
 * `dispatcher`; Bun's own ~300s idle timeout is disabled with `timeout: false`
 * at the call site (`backend.ts`). Each runtime honors only its own knob.
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
