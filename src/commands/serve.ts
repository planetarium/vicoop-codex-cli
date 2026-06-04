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
  type ChatCompletionsBody,
  type ChatFinishReason,
  type CodexUsage,
} from "../translate/chat-completions.js";
import { tryListModelIds } from "../client/models.js";
import {
  formatNotAuthenticated,
  missingModelMessage,
  printError,
} from "../cli/help-errors.js";

export interface ServeCmdOptions {
  port: number;
  host: string;
}

const ROUTE_PATH = "/v1/chat/completions";

function writeJsonError(
  res: http.ServerResponse,
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

async function streamChatCompletion(
  upstreamBody: ReadableStream<Uint8Array>,
  res: http.ServerResponse,
  requestedModel: string,
  includeUsage: boolean,
): Promise<void> {
  const created = Math.floor(Date.now() / 1000);
  let chatId: string | null = null;
  let model: string = requestedModel;
  let roleSent = false;
  let hasToolCalls = false;
  let toolCallIndex = 0;
  let finalUsage: CodexUsage | undefined;
  let finalStatus: string | undefined;
  let incompleteReason: string | undefined;

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
  };

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
    finalChunk.usage = {
      prompt_tokens: finalUsage.input_tokens ?? 0,
      completion_tokens: finalUsage.output_tokens ?? 0,
      total_tokens: finalUsage.total_tokens ?? 0,
    };
  }
  res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
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

  const requestedModel =
    typeof body.model === "string" ? body.model.trim() : undefined;
  if (!requestedModel) {
    logError("'model' missing or not a string", body);
    writeJsonError(res, 400, missingModelMessage(await tryListModelIds()), "invalid_request_error");
    return;
  }
  body.model = requestedModel;

  const clientWantsStream = body.stream === true;
  const { upstream: upstreamBody, dropped } = chatCompletionsToUpstream(body);
  if (dropped.length > 0) {
    process.stderr.write(
      `[${new Date().toISOString()}] dropped unsupported fields: ${dropped.join(", ")}\n`,
    );
  }

  let upstreamRes: Response;
  try {
    upstreamRes = await postUpstream(upstreamBody);
  } catch (err) {
    if (err instanceof NotAuthenticatedError) {
      logError("not authenticated", err);
      writeJsonError(res, 401, err.message, "authentication_error");
    } else {
      logError("upstream fetch threw", err);
      writeJsonError(res, 502, (err as Error).message ?? "upstream error");
    }
    return;
  }

  if (clientWantsStream) {
    if (!upstreamRes.ok || !upstreamRes.body) {
      const detail = await upstreamRes.text().catch(() => "");
      let message = detail || `upstream HTTP ${upstreamRes.status}`;
      try {
        const parsed = JSON.parse(detail) as { detail?: string; message?: string };
        message = parsed.detail ?? parsed.message ?? message;
      } catch {
        // not JSON, keep raw
      }
      logError(`upstream HTTP ${upstreamRes.status}`, { detail, upstreamBody });
      writeJsonError(res, upstreamRes.status, message);
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const includeUsage = body.stream_options?.include_usage !== false;
    await streamChatCompletion(upstreamRes.body, res, requestedModel, includeUsage);
    return;
  }

  const result = await collectChatCompletion(upstreamRes, requestedModel);
  if ("error" in result) {
    logError(`upstream HTTP ${result.error.status}`, { detail: result.error.message, upstreamBody });
    writeJsonError(res, result.error.status, result.error.message);
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(result.ok));
}

function getBaseUrl(req: http.IncomingMessage, opts: ServeCmdOptions): string {
  const forwardedProto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim();
  const forwardedHost = (req.headers["x-forwarded-host"] as string | undefined)?.split(",")[0]?.trim();
  const host = forwardedHost ?? (req.headers.host as string | undefined) ?? `${opts.host}:${opts.port}`;
  const proto = forwardedProto ?? "http";
  return `${proto}://${host}`;
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
      `  GET  ${base}${AGENT_CARD_PATH}        (A2A Agent Card)\n` +
      `  GET  ${base}${AGENT_CARD_PATH_ALT}  (A2A Agent Card — alt path)\n` +
      `  POST ${base}${A2A_ROUTE_PATH}        (A2A JSON-RPC, @a2x/sdk)\n` +
      `Backed by your local ChatGPT OAuth token.\n`,
  );

  return await new Promise<number>((resolve) => {
    const shutdown = () => {
      server.close(() => resolve(0));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}
