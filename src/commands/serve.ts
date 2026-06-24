import http from "node:http";
import { randomUUID } from "node:crypto";
import { parseSse } from "../client/sse.js";
import { postUpstream } from "../client/responses.js";
import { NotAuthenticatedError } from "../auth/manager.js";
import { readAuth } from "../auth/store.js";
import {
  A2A_ROUTE_PATH,
  AGENT_CARD_PATH,
  AGENT_CARD_PATH_ALT,
} from "../a2a/agent-card.js";
import { getA2ABundle } from "../a2a/handler.js";
import {
  chatCompletionsToUpstream,
  collectChatCompletion,
  determineFinishReason,
  makeChatId,
  toChatCompletionUsage,
  type ChatCompletionsBody,
  type ChatFinishReason,
  type CodexUsage,
} from "../translate/chat-completions.js";
import { tryListModelIds } from "../client/models.js";
import { fetchAllAccountUsage } from "../client/usage.js";
import {
  getDefaultModel,
  setDefaultModel,
  resetDefaultModelState,
  resolveDefaultModel,
  markModelRejected,
  isModelUnsupportedError,
} from "../client/default-model.js";
import { formatNotAuthenticated, printError } from "../cli/help-errors.js";

export interface ServeCmdOptions {
  port: number;
  host: string;
  // Optional seed for the in-memory default model used when a request omits
  // `model`. Validated against the live model list at startup. When unset (or
  // later found unavailable) the server self-heals it from `/models`.
  defaultModel?: string;
}

const ROUTE_PATH = "/v1/chat/completions";
const USAGE_PATH = "/usage";

// Minimal sink the streaming writers target. `http.ServerResponse` satisfies
// this structurally; tests pass a lightweight fake to capture emitted frames.
export interface StreamSink {
  write(chunk: string): unknown;
  end(chunk?: string): unknown;
  writeHead(status: number, headers: Record<string, string>): unknown;
  readonly writableEnded: boolean;
  readonly headersSent: boolean;
}

function writeJsonError(
  res: StreamSink,
  status: number,
  message: string,
  type = "api_error",
  code: string | null = null,
): void {
  if (!res.headersSent) {
    res.writeHead(status, { "content-type": "application/json" });
  }
  res.end(JSON.stringify({ error: { message, type, code } }));
}

function logError(label: string, detail?: unknown): void {
  const time = new Date().toISOString();
  let body = "";
  if (detail instanceof Error) {
    body = detail.stack ?? `${detail.name}: ${detail.message}`;
  } else if (typeof detail === "string") {
    body = detail;
  } else if (detail !== undefined && detail !== null) {
    try {
      body = JSON.stringify(detail, null, 2);
    } catch {
      body = String(detail);
    }
  }
  process.stderr.write(`[${time}] ERROR ${label}${body ? "\n" + body : ""}\n`);
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.length === 0) return {};
  return JSON.parse(raw);
}

export async function streamChatCompletion(
  upstreamBody: ReadableStream<Uint8Array>,
  res: StreamSink,
  requestedModel: string,
  includeUsage: boolean,
): Promise<void> {
  const created = Math.floor(Date.now() / 1000);
  let chatId: string | null = null;
  let model: string = requestedModel;
  let roleSent = false;
  let hasToolCalls = false;
  let toolCallIndex = 0;
  // Tracks whether we've emitted at least one reasoning-summary part, so the
  // second and later parts get a "\n\n" separator. Kept independent of the
  // role/content/finish bookkeeping — reasoning never affects finish reason.
  let reasoningPartSeen = false;
  let finalUsage: CodexUsage | undefined;
  let finalStatus: string | undefined;
  let incompleteReason: string | undefined;

  // Track the last time we wrote anything downstream. While the upstream is
  // silent (e.g. a reasoning model thinking before its first delta), we emit a
  // periodic SSE comment so the consumer's idle/body timeout never trips on an
  // otherwise-healthy long request. Comment lines (`:`-prefixed) are ignored by
  // SSE parsers, so they never reach the model output.
  let lastActivity = Date.now();
  const HEARTBEAT_MS = 15_000;

  const writeChunk = (delta: Record<string, unknown>, finish: string | null) => {
    if (res.writableEnded) return;
    const chunk = {
      id: chatId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    lastActivity = Date.now();
  };

  const heartbeat = setInterval(() => {
    if (res.writableEnded) return;
    if (Date.now() - lastActivity < HEARTBEAT_MS) return;
    res.write(": heartbeat\n\n");
    lastActivity = Date.now();
  }, HEARTBEAT_MS);
  // Don't let the keep-alive timer hold the process open on its own.
  (heartbeat as unknown as { unref?: () => void }).unref?.();

  try {
    for await (const ev of parseSse(upstreamBody)) {
      if (!ev.data || ev.data === "[DONE]") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(ev.data);
      } catch {
        continue;
      }
      const obj = parsed as {
        type?: string;
        response?: {
          id?: string;
          model?: string;
          usage?: CodexUsage;
          status?: string;
          incomplete_details?: { reason?: string } | null;
        };
        delta?: string;
        item?: {
          type?: string;
          call_id?: string;
          id?: string;
          name?: string;
          arguments?: string;
        };
        error?: { message?: string };
      };

      if (obj.type === "response.created" && obj.response) {
        if (obj.response.id) chatId = makeChatId(obj.response.id);
        if (obj.response.model) model = obj.response.model;
      } else if (obj.type === "response.output_text.delta" && typeof obj.delta === "string") {
        if (!roleSent) {
          writeChunk({ role: "assistant", content: "" }, null);
          roleSent = true;
        }
        writeChunk({ content: obj.delta }, null);
      } else if (obj.type === "response.output_item.done" && obj.item?.type === "function_call") {
        hasToolCalls = true;
        if (!roleSent) {
          writeChunk({ role: "assistant", content: null }, null);
          roleSent = true;
        }
        const toolCall = {
          index: toolCallIndex++,
          id:
            obj.item.call_id ??
            obj.item.id ??
            `call_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
          type: "function",
          function: {
            name: obj.item.name ?? "",
            arguments: obj.item.arguments ?? "",
          },
        };
        writeChunk({ tool_calls: [toolCall] }, null);
      } else if (
        obj.type === "response.reasoning_summary_text.delta" &&
        typeof obj.delta === "string"
      ) {
        // Relay the model's reasoning summary as `delta.reasoning_content`, the
        // standard OpenAI reasoning-model streaming field. Reasoning rides
        // alongside content and never leaks into `delta.content`; it is also
        // deliberately excluded from the finish-reason bookkeeping (which keys
        // only on output_text/tool_calls).
        if (!roleSent) {
          writeChunk({ role: "assistant", content: "" }, null);
          roleSent = true;
        }
        reasoningPartSeen = true;
        writeChunk({ reasoning_content: obj.delta }, null);
      } else if (obj.type === "response.reasoning_summary_part.added") {
        // Between reasoning-summary parts, emit a blank-line separator for
        // readability — but only after the first part has already streamed.
        if (reasoningPartSeen) {
          writeChunk({ reasoning_content: "\n\n" }, null);
        }
      } else if (obj.type === "response.completed") {
        finalUsage = obj.response?.usage;
        finalStatus = obj.response?.status;
        incompleteReason = obj.response?.incomplete_details?.reason;
      } else if (obj.type === "response.failed" || obj.type === "error") {
        const msg = obj.error?.message ?? "upstream stream failed";
        logError(`stream ${obj.type}`, obj);
        if (!res.headersSent) {
          writeJsonError(res, 502, msg);
        } else {
          res.write(`data: ${JSON.stringify({ error: { message: msg, type: "api_error", code: null } })}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
        }
        return;
      }
    }

    if (!chatId) chatId = makeChatId();
    if (!roleSent) writeChunk({ role: "assistant", content: "" }, null);

    const finishReason: ChatFinishReason = determineFinishReason(
      { status: finalStatus, incomplete_details: { reason: incompleteReason } },
      hasToolCalls,
    );
    const finalChunk: Record<string, unknown> = {
      id: chatId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    };
    if (finalUsage && includeUsage) {
      finalChunk.usage = toChatCompletionUsage(finalUsage);
    }
    res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  } finally {
    clearInterval(heartbeat);
  }
}

type PostResult =
  | { kind: "ok"; res: Response; model: string; dropped: string[] }
  | { kind: "error"; status: number; detail: string }
  | { kind: "threw"; err: unknown };

// Maximum self-heal retries for a request that used the auto-resolved default.
// Lets the server walk past several retired list-head models within one
// request; capped so a pathological backend can't loop unbounded.
const MAX_MODEL_HEALS = 3;

// POST to upstream, self-healing the default model on rejection. The request
// body is translated once; only the model field is swapped between attempts.
// When the model in use is the auto-resolved default and the backend reports it
// unavailable, the rejected id is recorded, the default re-resolves to the next
// usable advertised model, and the request retries (up to MAX_MODEL_HEALS).
// A model the client chose explicitly (usingDefault=false) is never
// substituted — its rejection rides through unchanged.
async function postUpstreamWithHeal(
  body: ChatCompletionsBody,
  initialModel: string,
  usingDefault: boolean,
): Promise<PostResult> {
  body.model = initialModel;
  const { upstream, dropped } = chatCompletionsToUpstream(body);
  let currentModel = initialModel;
  const maxHeals = usingDefault ? MAX_MODEL_HEALS : 0;
  // Always returns from inside the loop: `continue` only fires while
  // heals < maxHeals and the heal produced a new model; otherwise we return.
  for (let heals = 0; ; heals++) {
    (upstream as Record<string, unknown>).model = currentModel;
    let res: Response;
    try {
      res = await postUpstream(upstream);
    } catch (err) {
      return { kind: "threw", err };
    }
    if (res.ok && res.body) {
      return { kind: "ok", res, model: currentModel, dropped };
    }
    const detail = await res.text().catch(() => "");
    if (heals < maxHeals && isModelUnsupportedError(res.status, detail)) {
      markModelRejected(currentModel);
      const { model: healed } = await resolveDefaultModel(
        `backend rejected default model ${JSON.stringify(currentModel)}`,
      );
      if (healed && healed !== currentModel) {
        currentModel = healed;
        continue;
      }
    }
    return { kind: "error", status: res.status, detail };
  }
}

async function handleChatCompletions(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  let body: ChatCompletionsBody;
  try {
    body = (await readJsonBody(req)) as ChatCompletionsBody;
  } catch (err) {
    logError("invalid JSON body", err);
    writeJsonError(res, 400, "Invalid JSON body", "invalid_request_error");
    return;
  }

  process.stderr.write(
    `[${new Date().toISOString()}] POST ${ROUTE_PATH}\n${JSON.stringify(body, null, 2)}\n`,
  );

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    logError("'messages' missing or empty", body);
    writeJsonError(res, 400, "'messages' is required and must be a non-empty array", "invalid_request_error");
    return;
  }

  // Resolve the model. An explicit per-request model wins. Otherwise fall back
  // to the server default, resolving it on the fly when it isn't set yet
  // (rather than sending a doomed model-less request upstream).
  let model = typeof body.model === "string" ? body.model.trim() : "";
  const usingDefault = model.length === 0;
  if (usingDefault) {
    model = getDefaultModel() ?? "";
    if (!model) {
      const resolved = await resolveDefaultModel("no default model set");
      model = resolved.model ?? "";
      if (!model) {
        logError("'model' omitted and no default could be resolved", body);
        writeJsonError(
          res,
          400,
          "No model specified and no default could be resolved — the backend model list was empty or unavailable. " +
            "Pass a 'model' in the request, start serve with --default-model, or check that you're signed in and online.",
          "invalid_request_error",
        );
        return;
      }
    }
  }

  const clientWantsStream = body.stream === true;

  const result = await postUpstreamWithHeal(body, model, usingDefault);
  if (result.kind === "threw") {
    const err = result.err;
    if (err instanceof NotAuthenticatedError) {
      logError("not authenticated", err);
      writeJsonError(res, 401, err.message, "authentication_error");
    } else {
      logError("upstream fetch threw", err);
      writeJsonError(res, 502, (err as Error).message ?? "upstream error");
    }
    return;
  }
  if (result.kind === "error") {
    let message = result.detail || `upstream HTTP ${result.status}`;
    try {
      const parsed = JSON.parse(result.detail) as { detail?: string; message?: string };
      message = parsed.detail ?? parsed.message ?? message;
    } catch {
      // not JSON, keep raw
    }
    logError(`upstream HTTP ${result.status}`, { detail: result.detail });
    writeJsonError(res, result.status, message);
    return;
  }

  const { res: upstreamRes, model: effectiveModel, dropped } = result;
  if (dropped.length > 0) {
    process.stderr.write(
      `[${new Date().toISOString()}] dropped unsupported fields: ${dropped.join(", ")}\n`,
    );
  }

  if (clientWantsStream) {
    const upstreamBody = upstreamRes.body;
    if (!upstreamBody) {
      writeJsonError(res, 502, "upstream returned no response body");
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const includeUsage = body.stream_options?.include_usage !== false;
    await streamChatCompletion(upstreamBody, res, effectiveModel, includeUsage);
    return;
  }

  const collected = await collectChatCompletion(upstreamRes, effectiveModel);
  if ("error" in collected) {
    logError(`upstream HTTP ${collected.error.status}`, { detail: collected.error.message });
    writeJsonError(res, collected.error.status, collected.error.message);
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(collected.ok));
}

function getBaseUrl(req: http.IncomingMessage, opts: ServeCmdOptions): string {
  const forwardedProto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim();
  const forwardedHost = (req.headers["x-forwarded-host"] as string | undefined)?.split(",")[0]?.trim();
  const host = forwardedHost ?? (req.headers.host as string | undefined) ?? `${opts.host}:${opts.port}`;
  const proto = forwardedProto ?? "http";
  return `${proto}://${host}`;
}

async function handleUsage(res: http.ServerResponse): Promise<void> {
  const accounts = (await fetchAllAccountUsage()).map((r) => ({
    key: r.key,
    email: r.email ?? null,
    error: r.error ?? null,
    plan_type: r.usage?.plan_type ?? null,
    limit_reached: r.usage?.limit_reached ?? null,
    primary: r.usage?.primary ?? null,
    secondary: r.usage?.secondary ?? null,
    credits: r.usage?.credits ?? null,
  }));
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ accounts }));
}

async function handleAgentCard(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: ServeCmdOptions,
): Promise<void> {
  const baseUrl = getBaseUrl(req, opts);
  const { handler } = getA2ABundle(baseUrl);
  const card = handler.getAgentCard();
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(card));
}

async function handleA2A(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: ServeCmdOptions,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    logError("invalid JSON body (a2a)", err);
    res.writeHead(400, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      }),
    );
    return;
  }

  process.stderr.write(
    `[${new Date().toISOString()}] POST ${A2A_ROUTE_PATH}\n${JSON.stringify(body, null, 2)}\n`,
  );

  const { handler } = getA2ABundle(getBaseUrl(req, opts));

  let result;
  try {
    result = await handler.handle(body);
  } catch (err) {
    logError("a2a handler threw", err);
    res.writeHead(500, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: (body as { id?: unknown })?.id ?? null,
        error: { code: -32603, message: (err as Error).message ?? "Internal error" },
      }),
    );
    return;
  }

  if (result && typeof result === "object" && Symbol.asyncIterator in result) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    for await (const event of result as AsyncGenerator<unknown>) {
      if (res.writableEnded) break;
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    res.end();
    return;
  }

  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(result));
}

export async function serveCommand(opts: ServeCmdOptions): Promise<number> {
  const auth = await readAuth();
  if (!auth) {
    printError(formatNotAuthenticated());
    process.stderr.write(
      "\nThe server proxies requests using your local ChatGPT OAuth token, so it can't start without one.\n",
    );
    return 3;
  }

  // Resolve the in-memory default model at startup. Reset first so a re-run in
  // the same process begins clean. One /models fetch serves both branches:
  // validate an operator-supplied --default-model, or — when none was given —
  // auto-select the first (recommended) advertised model so the default is
  // always populated without waiting for the first model-less request.
  resetDefaultModelState();
  const seed = opts.defaultModel?.trim();
  const startupModels = await tryListModelIds();
  if (seed) {
    if (startupModels === null) {
      process.stderr.write(
        `[warn] could not fetch the model list to validate --default-model ${JSON.stringify(seed)}; ` +
          `proceeding — it will self-heal at request time if it turns out unavailable.\n`,
      );
      setDefaultModel(seed);
    } else if (!startupModels.includes(seed)) {
      printError(
        `--default-model ${JSON.stringify(seed)} is not in this account's available models.\n\n` +
          `Available models: ${startupModels.join(", ")}`,
      );
      return 2;
    } else {
      setDefaultModel(seed);
    }
  } else if (startupModels && startupModels.length > 0) {
    setDefaultModel(startupModels[0]);
    process.stderr.write(
      `no --default-model given; auto-selected ${JSON.stringify(startupModels[0])} ` +
        `(first of: ${startupModels.join(", ")})\n`,
    );
  } else {
    // Hard guarantee: a running server always has a default model. If none can
    // be resolved at startup (empty/unavailable model list and no
    // --default-model), refuse to start rather than serving with an unset
    // default. The bridge client surfaces this as serve_unavailable and can
    // retry once the backend recovers.
    printError(
      "Could not resolve a default model at startup — the backend model list was empty or unavailable.\n\n" +
        "serve requires a usable default model. Check that you're signed in and online, or pass --default-model <id> explicitly.",
    );
    return 4;
  }

  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === ROUTE_PATH) {
      handleChatCompletions(req, res).catch((err) => {
        logError("handler threw", err);
        writeJsonError(res, 500, (err as Error).message ?? String(err));
      });
      return;
    }
    if (
      req.method === "GET" &&
      (req.url === AGENT_CARD_PATH || req.url === AGENT_CARD_PATH_ALT)
    ) {
      handleAgentCard(req, res, opts).catch((err) => {
        logError("agent-card handler threw", err);
        writeJsonError(res, 500, (err as Error).message ?? String(err));
      });
      return;
    }
    if (req.method === "POST" && req.url === A2A_ROUTE_PATH) {
      handleA2A(req, res, opts).catch((err) => {
        logError("a2a handler threw", err);
        writeJsonError(res, 500, (err as Error).message ?? String(err));
      });
      return;
    }
    if (req.method === "GET" && (req.url === USAGE_PATH || req.url === "/v1/usage")) {
      handleUsage(res).catch((err) => {
        logError("usage handler threw", err);
        writeJsonError(res, 500, (err as Error).message ?? String(err));
      });
      return;
    }
    writeJsonError(res, 404, `Not Found: ${req.method} ${req.url}`, "invalid_request_error");
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once("error", onError);
    server.listen(opts.port, opts.host, () => {
      server.removeListener("error", onError);
      resolve();
    });
  });

  const address = server.address();
  const boundPort =
    address !== null && typeof address === "object" ? address.port : opts.port;
  const base = `http://${opts.host}:${boundPort}`;
  process.stderr.write(
    JSON.stringify({
      event: "listening",
      host: opts.host,
      port: boundPort,
      url: base,
    }) + "\n",
  );
  process.stderr.write(
    `vicoop-codex serve listening on:\n` +
      `  POST ${base}${ROUTE_PATH}        (OpenAI Chat Completions)\n` +
      `  GET  ${base}${USAGE_PATH}                      (per-account remaining Codex usage)\n` +
      `  GET  ${base}${AGENT_CARD_PATH}        (A2A Agent Card)\n` +
      `  GET  ${base}${AGENT_CARD_PATH_ALT}  (A2A Agent Card — alt path)\n` +
      `  POST ${base}${A2A_ROUTE_PATH}        (A2A JSON-RPC, @a2x/sdk)\n` +
      `Backed by your local ChatGPT OAuth token.\n` +
      `Default model (for requests that omit one; may self-heal if retired): ${getDefaultModel() ?? "(unset)"}\n`,
  );

  return await new Promise<number>((resolve) => {
    const shutdown = () => {
      server.close(() => resolve(0));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}
