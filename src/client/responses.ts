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
 * Combine the caller's abort signal (if any) with an absolute upstream
 * deadline, so the request is aborted when *either* fires.
 */
function withDeadline(signal?: AbortSignal): AbortSignal {
  const deadline = AbortSignal.timeout(UPSTREAM_DEADLINE_MS);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
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
// RAW upstream bytes — the `: a2a-heartbeat` liveness comments are injected by
// the downstream serve/A2A layer, NOT here — so an `error`/`end` phase with
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
  logUpstream({ seq, phase: "start", deadlineMs: UPSTREAM_DEADLINE_MS });
  let res: Response;
  try {
    res = await fetchCodexBackend(
      "/responses",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify(body),
        signal: withDeadline(signal),
      },
      undefined,
      opts,
    );
  } catch (err) {
    // Aborted/failed before response headers (e.g. deadline fired during connect).
    logUpstream({
      seq,
      phase: "error",
      when: "pre_headers",
      ms: Date.now() - startedAt,
      err: (err as Error)?.message ?? String(err),
    });
    throw err;
  }
  logUpstream({
    seq,
    phase: "headers",
    ms: Date.now() - startedAt,
    status: res.status,
    ok: res.ok,
    model: res.headers.get("openai-model") ?? undefined,
    reqId:
      res.headers.get("x-request-id") ??
      res.headers.get("cf-ray") ??
      undefined,
  });
  if (!res.ok || !res.body) return res;
  return new Response(instrumentBody(res.body, seq, startedAt), {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
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
