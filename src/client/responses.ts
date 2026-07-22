import { appendFile } from "node:fs";
import {
  fetchCodexBackend,
  type FetchCodexOptions,
  type UsedAccountInfo,
} from "./backend.js";
import { parseSse } from "./sse.js";

export type ReasoningEffort = "low" | "medium" | "high";

export interface RunRequest {
  /**
   * Model identifier — e.g. "gpt-5.5". Required: there is no default and the
   * backend rejects requests without a valid model. Callers must validate this
   * before invoking; run `vicoop-codex models` to list available slugs.
   */
  model: string;
  /** Optional system-style instructions sent at the top of the request. */
  instructions?: string;
  /** The user's prompt text. */
  prompt: string;
  /** Reasoning effort. Defaults to "medium". Set to undefined to omit. */
  reasoningEffort?: ReasoningEffort;
  /**
   * When false (default), the prompt is not stored on the server. The ChatGPT
   * Codex backend in fact requires store:false (it rejects store:true), so this
   * is effectively fixed; prompt caching works regardless via prompt_cache_key.
   */
  store?: boolean;
  /**
   * Optional cache-routing key sent upstream as `prompt_cache_key`. Pins
   * same-prefix requests to one cache shard; when omitted the backend routes
   * by prefix hash alone.
   */
  promptCacheKey?: string;
}

export interface ResponseUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  // Responses-API detail breakdowns, forwarded verbatim by `runResponse`
  // (we assign `resp.usage` whole). Modelled as open records so any sub-field
  // OpenAI reports (cached_tokens, reasoning_tokens, audio_tokens, …) is
  // typed-visible and passes through without a code change.
  input_tokens_details?: Record<string, unknown>;
  output_tokens_details?: Record<string, unknown>;
}

export interface StreamCallbacks {
  /** Called for every text delta chunk. */
  onTextDelta?: (delta: string) => void;
  /** Called when the response is completed with usage info. */
  onCompleted?: (info: { responseId?: string; usage?: ResponseUsage }) => void;
  /** Called on any non-fatal stream event the client did not specifically handle. */
  onEvent?: (event: { type: string; raw: unknown }) => void;
}

export interface RunResult {
  text: string;
  responseId?: string;
  usage?: ResponseUsage;
  model?: string;
  /** Which enrolled account served this request (multi-account). */
  account?: UsedAccountInfo;
}

const DEFAULT_INSTRUCTIONS = "You are a helpful assistant.";

function buildBody(req: RunRequest): unknown {
  const body: Record<string, unknown> = {
    model: req.model,
    instructions:
      req.instructions && req.instructions.length > 0
        ? req.instructions
        : DEFAULT_INSTRUCTIONS,
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: req.prompt }],
      },
    ],
    tools: [],
    tool_choice: "auto",
    parallel_tool_calls: false,
    store: req.store ?? false,
    stream: true,
    include: [],
  };
  if (req.promptCacheKey && req.promptCacheKey.length > 0) {
    body.prompt_cache_key = req.promptCacheKey;
  }
  if (req.reasoningEffort !== undefined) {
    // Request a reasoning summary alongside the effort so the upstream
    // `/responses` stream emits `response.reasoning_summary_text.delta`
    // events. `summary: "auto"` only affects reasoning models; non-reasoning
    // models ignore it.
    body.reasoning = { effort: req.reasoningEffort, summary: "auto" };
  }
  return body;
}

/**
 * Absolute ceiling for a single `/responses` call. The runtime's inter-chunk
 * idle timeout is disabled for that call (`backend.ts`, via Bun's
 * `timeout: false`) so long silent reasoning gaps don't abort the stream; this
 * deadline is what guards against a genuinely stuck upstream. Kept just under
 * the bridge client's per-task timeout (10 min) so a stall surfaces here as a
 * clean error before the bridge gives up. Override with
 * `VICOOP_CODEX_UPSTREAM_TIMEOUT_MS`.
 */
const UPSTREAM_DEADLINE_MS =
  Number(process.env.VICOOP_CODEX_UPSTREAM_TIMEOUT_MS) || 9 * 60 * 1000;

/**
 * First-header watchdog: max time to wait for the upstream RESPONSE HEADERS to
 * arrive on a `/responses` attempt before treating it as a stall — aborting that
 * connection and retrying a fresh one. Keyed on *headers only*, never on first
 * content: a reasoning model legitimately delays its first content byte by
 * minutes, but never delays the headers (observed: normal header latency <8s; a
 * genuine backend stall delays the headers 300–440s — a huge, cleanly separable
 * gap). Set safely above the normal ceiling and far below any real header.
 * Implemented as a real timer racing the headers promise (NOT a value handed to
 * fetch — see LiteLLM #19909, where a downstream-passed timeout never fired
 * during the wait). Override with `VICOOP_CODEX_UPSTREAM_FIRST_HEADER_MS`;
 * set it to 0 to disable the watchdog entirely.
 */
const UPSTREAM_FIRST_HEADER_MS = (() => {
  const raw = process.env.VICOOP_CODEX_UPSTREAM_FIRST_HEADER_MS;
  if (raw === undefined || raw === "") return 60_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 60_000;
})();

/**
 * How many EXTRA attempts to make after a first-header stall OR a retryable
 * received-but-error status (5xx/408/409/425/429 — see `isRetryableStatus`), so
 * total attempts = 1 + this. One shared budget across both retry causes.
 * Bounded so a persistently wedged backend can't loop forever.
 * Override with `VICOOP_CODEX_UPSTREAM_MAX_RETRIES`.
 */
const UPSTREAM_MAX_RETRIES = (() => {
  const raw = process.env.VICOOP_CODEX_UPSTREAM_MAX_RETRIES;
  if (raw === undefined || raw === "") return 2;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 2;
})();

/**
 * Whether the FINAL attempt runs "patient": with the first-header watchdog
 * disabled, so it waits out a slow-but-eventually-served turn (headers at
 * 300–440s) up to the shared deadline instead of aborting at the watchdog and
 * failing. Earlier attempts still abort fast and retry — this only changes the
 * last one, trading a fast failure for a chance at a late success (the stall is
 * often per-connection queuing, so a fresh connection usually wins first; but if
 * every retry also stalls, we'd rather ride the last one out than fail a request
 * that might still complete). On by default; set
 * `VICOOP_CODEX_UPSTREAM_PATIENT_LAST=0` to make every attempt — including the
 * last — fail fast at the watchdog with `upstream_stalled`.
 *
 * Interaction with MAX_RETRIES=0: the sole attempt IS the last, so patient-last
 * then disables the watchdog entirely (the original passive, wait-for-deadline
 * behavior). Disable patient-last to get a single fast-fail attempt.
 */
const UPSTREAM_PATIENT_LAST = !/^(0|off|false|no)$/i.test(
  process.env.VICOOP_CODEX_UPSTREAM_PATIENT_LAST ?? "",
);

/**
 * Base delay before retrying an attempt that came back with a retryable error
 * STATUS (as opposed to a stall, which retries immediately — by the time the
 * watchdog fires, ~60s have already passed). A bad status can arrive within
 * milliseconds, so a short pause avoids hammering an upstream that is actively
 * erroring. Scaled linearly by attempt; a valid `Retry-After` header takes
 * precedence. Override with `VICOOP_CODEX_UPSTREAM_RETRY_BACKOFF_MS`.
 */
const UPSTREAM_RETRY_BACKOFF_MS = (() => {
  const raw = process.env.VICOOP_CODEX_UPSTREAM_RETRY_BACKOFF_MS;
  if (raw === undefined || raw === "") return 1_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 1_000;
})();

/** Ceiling for any single bad-status retry delay (incl. `Retry-After`). */
const UPSTREAM_RETRY_BACKOFF_CAP_MS = 30_000;

/** Sentinel resolved by the first-header watchdog when it wins the race. */
const STALL = Symbol("upstream_stall");

/**
 * Received-but-error statuses worth retrying on a fresh connection to the SAME
 * account (issue #45: a transient Cloudflare 520 with headers is never a stall,
 * so it previously surfaced straight to the caller). Deliberately narrower than
 * backend.ts's `isFallbackWorthyStatus`: auth failures (401/403) are excluded
 * because an immediate same-account retry cannot fix them — 401 already gets a
 * one-shot token refresh inside `fetchCodexBackend`.
 */
function isRetryableStatus(status: number): boolean {
  return (
    status === 408 ||
    status === 409 ||
    status === 425 ||
    status === 429 ||
    status >= 500
  );
}

/** Parse a `Retry-After` header (delta-seconds or HTTP-date) into millis. */
function retryAfterMs(res: Response): number | undefined {
  const raw = res.headers.get("retry-after");
  if (!raw) return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

/** Sleep that resolves early (never rejects) when the signal aborts. */
function interruptibleSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    (timer as unknown as { unref?: () => void }).unref?.();
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Combine abort signals; the result fires when the first of them does. */
function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const present = signals.filter((s): s is AbortSignal => s !== undefined);
  return present.length === 1 ? present[0] : AbortSignal.any(present);
}

export class ApiError extends Error {
  status: number;
  detail?: string;
  constructor(status: number, message: string, detail?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

async function readErrorBody(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

// ── Upstream instrumentation ────────────────────────────────────────────────
// Structured logging of the raw ChatGPT `/responses` call: request start,
// response headers (status + time-to-headers), the first upstream byte, and
// stream end/abort with byte totals. This is the ONLY place that observes the
// RAW upstream bytes — the `: heartbeat` liveness comments are injected by the
// downstream serve streaming layer, NOT here — so an `error`/`end` phase with
// `firstByte:false, bytes:0` is direct proof the backend produced nothing
// (distinguishing a genuinely silent upstream from a slow-but-streaming one).
//
// Lines are tagged `[upstream]` (JSON). Sinks:
//   - stderr — on by default; disable with VICOOP_CODEX_UPSTREAM_LOG=0. Note the
//     bridge (`vicoop-client`) spawns `vicoop-codex serve` as a child and
//     CAPTURES its stdio, so stderr lines do NOT reach `journalctl` in that
//     deployment — use the file sink there.
//   - file — set VICOOP_CODEX_UPSTREAM_LOG_FILE=/path/to/upstream.log to append
//     there regardless of how stdio is wired (recommended for the bridge). The
//     file is append-only; rotate/truncate it out of band.
const UPSTREAM_LOG_ENABLED = !/^(0|off|false|no)$/i.test(
  process.env.VICOOP_CODEX_UPSTREAM_LOG ?? "",
);
const UPSTREAM_LOG_FILE = process.env.VICOOP_CODEX_UPSTREAM_LOG_FILE || "";
let upstreamSeq = 0;

function logUpstream(fields: Record<string, unknown>): void {
  if (!UPSTREAM_LOG_ENABLED && !UPSTREAM_LOG_FILE) return;
  const line = `[upstream] ${JSON.stringify({ ts: new Date().toISOString(), ...fields })}\n`;
  if (UPSTREAM_LOG_ENABLED) {
    try {
      process.stderr.write(line);
    } catch {
      // Observational only — never let logging break a request.
    }
  }
  if (UPSTREAM_LOG_FILE) {
    // Async, fire-and-forget: never block the stream on disk IO, and swallow
    // errors (a bad path must not fail requests).
    appendFile(UPSTREAM_LOG_FILE, line, () => {});
  }
}

/**
 * Wrap an upstream body stream to log first-byte latency, byte/chunk totals,
 * and how it ended (clean close vs abort/timeout/cancel) — WITHOUT altering the
 * bytes (each chunk is enqueued verbatim). A `first_byte` line that never
 * appears before an `error` line is the signature of a wedged/silent upstream.
 */
function instrumentBody(
  body: ReadableStream<Uint8Array>,
  seq: number,
  startedAt: number,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let bytes = 0;
  let chunks = 0;
  let firstByte = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          logUpstream({ seq, phase: "end", ms: Date.now() - startedAt, bytes, chunks, firstByte });
          controller.close();
          return;
        }
        if (!firstByte) {
          firstByte = true;
          logUpstream({ seq, phase: "first_byte", ms: Date.now() - startedAt, bytes: value.byteLength });
        }
        bytes += value.byteLength;
        chunks += 1;
        controller.enqueue(value);
      } catch (err) {
        logUpstream({
          seq,
          phase: "error",
          ms: Date.now() - startedAt,
          bytes,
          chunks,
          firstByte,
          err: (err as Error)?.message ?? String(err),
        });
        controller.error(err);
      }
    },
    cancel(reason) {
      logUpstream({
        seq,
        phase: "cancel",
        ms: Date.now() - startedAt,
        bytes,
        chunks,
        firstByte,
        reason: (reason as Error)?.message ?? String(reason ?? ""),
      });
      return reader.cancel(reason);
    },
  });
}

/**
 * POST raw body to the ChatGPT Codex backend with auth + one-shot refresh on 401.
 * Returns the upstream Response without consuming its body. When the response is
 * a streaming success its body is wrapped with `instrumentBody` so raw upstream
 * timing (first byte, totals, abort cause) is logged; the bytes are unchanged.
 */
export async function postUpstream(
  body: unknown,
  signal?: AbortSignal,
  opts?: FetchCodexOptions,
): Promise<Response> {
  const seq = ++upstreamSeq;
  const startedAt = Date.now();
  logUpstream({
    seq,
    phase: "start",
    deadlineMs: UPSTREAM_DEADLINE_MS,
    firstHeaderMs: UPSTREAM_FIRST_HEADER_MS,
    maxRetries: UPSTREAM_MAX_RETRIES,
    patientLast: UPSTREAM_PATIENT_LAST,
  });

  const payload = JSON.stringify(body);
  // A single absolute deadline spans ALL attempts, so retrying on a stall can
  // never push the total past the bridge's per-task timeout (the retries fire
  // fast — at the ~60s watchdog, not the 9-min deadline).
  const deadline = AbortSignal.timeout(UPSTREAM_DEADLINE_MS);

  for (let attempt = 0; ; attempt++) {
    // Per-attempt controller: the first-header watchdog aborts THIS connection
    // (closing it so foreground generation stops upstream — verified: the
    // `/responses` body is `stream:true, store:false`, never `background:true`)
    // without disturbing the caller's signal or the shared deadline.
    const attemptController = new AbortController();
    const attemptSignal = combineSignals(signal, deadline, attemptController.signal);

    // Disable the watchdog on the final attempt when patient-last is on, so it
    // rides a slow-but-eventually-served turn out to the shared deadline rather
    // than aborting and failing. Earlier attempts always keep the watchdog.
    const isLastAttempt = attempt >= UPSTREAM_MAX_RETRIES;
    const watchdogActive =
      UPSTREAM_FIRST_HEADER_MS > 0 && !(isLastAttempt && UPSTREAM_PATIENT_LAST);
    if (UPSTREAM_FIRST_HEADER_MS > 0 && isLastAttempt && UPSTREAM_PATIENT_LAST) {
      logUpstream({
        seq,
        phase: "patient",
        attempt,
        ms: Date.now() - startedAt,
      });
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const stalled = new Promise<typeof STALL>((resolve) => {
      if (!watchdogActive) return; // watchdog disabled (globally or patient last)
      timer = setTimeout(() => resolve(STALL), UPSTREAM_FIRST_HEADER_MS);
      (timer as unknown as { unref?: () => void }).unref?.();
    });

    const fetchPromise = fetchCodexBackend(
      "/responses",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: payload,
        signal: attemptSignal,
      },
      undefined,
      opts,
    );

    let outcome: Response | typeof STALL;
    try {
      // Race the arrival of the response HEADERS against the watchdog. Only the
      // headers are watched — once they arrive the streaming body path (bounded
      // by the shared 9-min deadline) handles any legitimately slow reasoning.
      outcome = await Promise.race([fetchPromise, stalled]);
    } catch (err) {
      // Aborted/failed before response headers (deadline/caller-abort/network).
      clearTimeout(timer);
      logUpstream({
        seq,
        phase: "error",
        when: "pre_headers",
        attempt,
        ms: Date.now() - startedAt,
        err: (err as Error)?.message ?? String(err),
      });
      throw err;
    }
    clearTimeout(timer);

    if (outcome === STALL) {
      // Close this attempt's connection so the backend stops generating, then
      // decide whether to retry a fresh connection or give up.
      attemptController.abort(
        new Error(`no upstream response headers for ${UPSTREAM_FIRST_HEADER_MS}ms`),
      );
      // Drain/swallow whatever the aborted fetch ultimately settles to (an
      // AbortError, or a late Response we no longer want) so it can't leak.
      void fetchPromise.then(
        (r) => void r.body?.cancel().catch(() => {}),
        () => {},
      );
      logUpstream({
        seq,
        phase: "stall",
        attempt,
        ms: Date.now() - startedAt,
        firstHeaderMs: UPSTREAM_FIRST_HEADER_MS,
      });
      if (attempt < UPSTREAM_MAX_RETRIES) {
        logUpstream({
          seq,
          phase: "retry",
          attempt: attempt + 1,
          ms: Date.now() - startedAt,
        });
        continue;
      }
      logUpstream({
        seq,
        phase: "error",
        when: "stalled",
        attempt,
        ms: Date.now() - startedAt,
        err: "upstream_stalled",
      });
      throw new ApiError(
        504,
        `upstream produced no response headers for ${UPSTREAM_FIRST_HEADER_MS}ms after ${attempt + 1} attempt(s)`,
        "upstream_stalled",
      );
    }

    const res = outcome;
    logUpstream({
      seq,
      phase: "headers",
      attempt,
      ms: Date.now() - startedAt,
      status: res.status,
      ok: res.ok,
      model: res.headers.get("openai-model") ?? undefined,
      reqId:
        res.headers.get("x-request-id") ??
        res.headers.get("cf-ray") ??
        undefined,
    });
    // A received-but-error status (e.g. a transient Cloudflare 520) is not a
    // stall — headers arrived — but before any body bytes have been streamed it
    // is just as safe to retry: nothing has been emitted downstream, and the
    // request body is a re-sendable string. Retry retryable statuses on a fresh
    // connection, sharing the attempt budget (and absolute deadline) with the
    // stall path. The LAST attempt's response is always returned as-is so
    // error formatting downstream is unchanged.
    if (!res.ok && isRetryableStatus(res.status) && attempt < UPSTREAM_MAX_RETRIES) {
      await res.body?.cancel().catch(() => {});
      const remaining = UPSTREAM_DEADLINE_MS - (Date.now() - startedAt);
      const delayMs = Math.max(
        0,
        Math.min(
          retryAfterMs(res) ?? UPSTREAM_RETRY_BACKOFF_MS * (attempt + 1),
          UPSTREAM_RETRY_BACKOFF_CAP_MS,
          remaining,
        ),
      );
      logUpstream({
        seq,
        phase: "retry",
        when: "bad_status",
        status: res.status,
        attempt: attempt + 1,
        delayMs,
        ms: Date.now() - startedAt,
      });
      // If the caller aborts or the deadline fires mid-sleep, the next fetch
      // attempt rejects immediately and surfaces through the pre_headers path.
      await interruptibleSleep(delayMs, combineSignals(signal, deadline));
      continue;
    }
    if (!res.ok || !res.body) return res;
    return new Response(instrumentBody(res.body, seq, startedAt), {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  }
}

export async function runResponse(
  req: RunRequest,
  callbacks: StreamCallbacks = {},
  signal?: AbortSignal,
): Promise<RunResult> {
  const body = buildBody(req);
  let account: UsedAccountInfo | undefined;
  const res = await postUpstream(body, signal, {
    onAccount: (info) => {
      account = info;
    },
  });

  if (!res.ok || !res.body) {
    const detail = await readErrorBody(res);
    throw new ApiError(
      res.status,
      `ChatGPT backend returned HTTP ${res.status}`,
      detail.slice(0, 1000),
    );
  }

  let text = "";
  let responseId: string | undefined;
  let usage: ResponseUsage | undefined;
  const model = res.headers.get("openai-model") ?? undefined;

  for await (const ev of parseSse(res.body)) {
    if (!ev.data) continue;
    if (ev.data === "[DONE]") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(ev.data);
    } catch {
      callbacks.onEvent?.({ type: ev.event ?? "unknown", raw: ev.data });
      continue;
    }
    const type =
      (typeof parsed === "object" && parsed !== null && "type" in parsed
        ? (parsed as { type?: unknown }).type
        : undefined) ?? ev.event;

    if (typeof type !== "string") {
      callbacks.onEvent?.({ type: ev.event ?? "unknown", raw: parsed });
      continue;
    }

    switch (type) {
      case "response.output_text.delta": {
        const delta = (parsed as { delta?: unknown }).delta;
        if (typeof delta === "string") {
          text += delta;
          callbacks.onTextDelta?.(delta);
        }
        break;
      }
      case "response.completed": {
        const resp = (parsed as { response?: { id?: string; usage?: ResponseUsage } }).response;
        responseId = resp?.id ?? responseId;
        usage = resp?.usage ?? usage;
        callbacks.onCompleted?.({ responseId, usage });
        break;
      }
      case "response.created": {
        const resp = (parsed as { response?: { id?: string } }).response;
        responseId = resp?.id ?? responseId;
        callbacks.onEvent?.({ type, raw: parsed });
        break;
      }
      case "response.failed":
      case "error": {
        const errObj = (parsed as { response?: { error?: { message?: string; code?: string } }; error?: { message?: string; code?: string } });
        const inner = errObj.response?.error ?? errObj.error;
        const message = inner?.message ?? "stream reported failure";
        throw new ApiError(0, message, inner?.code);
      }
      default:
        callbacks.onEvent?.({ type, raw: parsed });
        break;
    }
  }

  return { text, responseId, usage, model, account };
}
