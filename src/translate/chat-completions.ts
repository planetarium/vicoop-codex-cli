import { randomUUID } from "node:crypto";
import { parseSse } from "../client/sse.js";

export const DEFAULT_INSTRUCTIONS = "You are a helpful assistant.";

export interface ChatMessagePart {
  type?: string;
  text?: string;
}

export interface ChatToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

export interface ChatMessage {
  role?: string;
  content?: string | ChatMessagePart[] | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ChatToolCall[];
}

export interface ChatCompletionsBody {
  model?: string;
  messages?: ChatMessage[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  tools?: Array<{ type?: string; function?: Record<string, unknown> }>;
  tool_choice?:
    | string
    | { type?: string; function?: { name?: string } };
  parallel_tool_calls?: boolean;
  reasoning_effort?: string;
  [k: string]: unknown;
}

export interface CodexUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  // Responses-API detail breakdowns. Forwarded verbatim — we deliberately
  // do NOT enumerate the inner fields (cached_tokens, reasoning_tokens,
  // audio_tokens, …) so any breakdown OpenAI reports rides through without
  // a code change.
  input_tokens_details?: Record<string, unknown>;
  output_tokens_details?: Record<string, unknown>;
}

// Map a Responses-API usage block to the OpenAI Chat Completions usage shape.
// The three scalar counts are renamed (input→prompt, output→completion); the
// `*_tokens_details` breakdowns are passed through verbatim under their
// Chat-Completions key names (`prompt_tokens_details` /
// `completion_tokens_details`) so every sub-field OpenAI surfaces — cached
// prompt tokens, reasoning tokens, and anything added later — reaches the
// caller untouched. Returns the zero-filled scalar block when `usage` is
// absent, matching the prior always-emit-usage behaviour.
export function toChatCompletionUsage(
  usage: CodexUsage | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    prompt_tokens: usage?.input_tokens ?? 0,
    completion_tokens: usage?.output_tokens ?? 0,
    total_tokens: usage?.total_tokens ?? 0,
  };
  if (usage?.input_tokens_details && typeof usage.input_tokens_details === "object") {
    out.prompt_tokens_details = usage.input_tokens_details;
  }
  if (usage?.output_tokens_details && typeof usage.output_tokens_details === "object") {
    out.completion_tokens_details = usage.output_tokens_details;
  }
  return out;
}

export interface CodexResponse {
  id?: string;
  created_at?: number;
  model?: string;
  usage?: CodexUsage;
  status?: string;
  incomplete_details?: { reason?: string } | null;
}

export type ChatFinishReason = "stop" | "length" | "tool_calls" | "content_filter";

export function determineFinishReason(
  finalResponse: Pick<CodexResponse, "status" | "incomplete_details">,
  hasToolCalls: boolean,
): ChatFinishReason {
  if (hasToolCalls) return "tool_calls";
  if (finalResponse.status === "incomplete") {
    const reason = finalResponse.incomplete_details?.reason;
    if (reason === "max_output_tokens") return "length";
    if (reason === "content_filter") return "content_filter";
  }
  return "stop";
}

export const UPSTREAM_ACCEPTED_FIELDS = new Set([
  "model",
  "instructions",
  "input",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "reasoning",
  "store",
  "stream",
  "include",
  "text",
  "prompt_cache_key",
]);

export const CHAT_FIELDS_CONSUMED = new Set([
  "model",
  "messages",
  "stream",
  "stream_options",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "reasoning_effort",
  "response_format",
  "prompt_cache_key",
]);

export function extractText(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const part of content) {
    if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string") {
      out += part.text;
    }
  }
  return out;
}

export interface UpstreamBuildResult {
  upstream: Record<string, unknown>;
  dropped: string[];
}

export function chatCompletionsToUpstream(body: ChatCompletionsBody): UpstreamBuildResult {
  const systemTexts: string[] = [];
  const inputItems: unknown[] = [];
  const droppedContentTypes = new Set<string>();

  for (const msg of body.messages ?? []) {
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part && typeof part === "object" && typeof part.type === "string" && part.type !== "text") {
          droppedContentTypes.add(part.type);
        }
      }
    }
    const role = msg.role;
    if (role === "system" || role === "developer") {
      const t = extractText(msg.content);
      if (t.length > 0) systemTexts.push(t);
      continue;
    }
    if (role === "user") {
      const t = extractText(msg.content);
      inputItems.push({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: t }],
      });
      continue;
    }
    if (role === "assistant") {
      const t = extractText(msg.content);
      if (t.length > 0) {
        inputItems.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: t }],
        });
      }
      if (Array.isArray(msg.tool_calls)) {
        for (const call of msg.tool_calls) {
          if (call?.type === "function" && call.function) {
            inputItems.push({
              type: "function_call",
              call_id: call.id ?? "",
              name: call.function.name ?? "",
              arguments: call.function.arguments ?? "",
            });
          }
        }
      }
      continue;
    }
    if (role === "tool" || role === "function") {
      inputItems.push({
        type: "function_call_output",
        call_id: msg.tool_call_id ?? "",
        output: extractText(msg.content),
      });
      continue;
    }
  }

  const tools = (body.tools ?? []).map((t) => {
    if (t && t.type === "function" && t.function && typeof t.function === "object") {
      return { type: "function", ...t.function };
    }
    return t;
  });

  let toolChoice: unknown;
  if (body.tool_choice !== undefined) {
    toolChoice = body.tool_choice;
    if (toolChoice && typeof toolChoice === "object") {
      const tc = toolChoice as { type?: string; function?: { name?: string } };
      if (tc.type === "function" && tc.function?.name) {
        toolChoice = { type: "function", name: tc.function.name };
      }
    }
  } else {
    toolChoice = tools.length > 0 ? "auto" : "none";
  }

  const candidate: Record<string, unknown> = {
    // No default: callers must validate `model` before reaching here. When it
    // is absent the key serializes away and the backend rejects with a clear
    // "model is required" error rather than silently using a stale slug.
    model: body.model,
    instructions: systemTexts.length > 0 ? systemTexts.join("\n\n") : DEFAULT_INSTRUCTIONS,
    input: inputItems,
    tools,
    tool_choice: toolChoice,
    // Must be false: the ChatGPT Codex backend hard-rejects store:true with
    // "Store must be set to false". Prompt caching still works under
    // store:false — it is driven by the stable prefix + prompt_cache_key, not
    // by server-side storage.
    store: false,
    stream: true,
    include: [],
  };

  // Pass a caller-supplied prompt_cache_key through verbatim (e.g. the
  // vicoop-bridge's per-conversation task.contextId) to pin same-prefix
  // requests to one cache shard. When absent we send nothing: the backend
  // already routes by prefix hash, so a locally derived key would only
  // re-encode that same prefix without improving stickiness.
  if (typeof body.prompt_cache_key === "string" && body.prompt_cache_key.length > 0) {
    candidate.prompt_cache_key = body.prompt_cache_key;
  }

  if (typeof body.parallel_tool_calls === "boolean") {
    candidate.parallel_tool_calls = body.parallel_tool_calls;
  }

  candidate.reasoning = {
    effort:
      typeof body.reasoning_effort === "string"
        ? body.reasoning_effort
        : "medium",
  };

  const responseFormat = body.response_format;
  if (responseFormat && typeof responseFormat === "object") {
    const rf = responseFormat as { type?: string; json_schema?: Record<string, unknown> };
    if (rf.type === "json_schema" && rf.json_schema && typeof rf.json_schema === "object") {
      candidate.text = { format: { type: "json_schema", ...rf.json_schema } };
    } else if (rf.type) {
      candidate.text = { format: { ...rf } };
    }
  }

  const upstream: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(candidate)) {
    if (UPSTREAM_ACCEPTED_FIELDS.has(k)) upstream[k] = v;
  }

  const dropped: string[] = [];
  for (const k of Object.keys(body)) {
    if (CHAT_FIELDS_CONSUMED.has(k)) continue;
    dropped.push(k);
  }
  if (droppedContentTypes.size > 0) {
    dropped.push(`messages[].content[] non-text parts: ${[...droppedContentTypes].sort().join(", ")}`);
  }

  return { upstream, dropped };
}

export function makeChatId(upstreamId?: string): string {
  if (upstreamId) return `chatcmpl-${upstreamId.replace(/^resp_/, "")}`;
  return `chatcmpl-${randomUUID().replace(/-/g, "")}`;
}

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface AssembledChoice {
  content: string;
  toolCalls: ToolCall[];
}

function assembleChoice(outputItems: unknown[]): AssembledChoice {
  let content = "";
  const toolCalls: ToolCall[] = [];
  for (const item of outputItems) {
    if (!item || typeof item !== "object") continue;
    const it = item as {
      type?: string;
      content?: unknown;
      name?: string;
      arguments?: string;
      call_id?: string;
      id?: string;
    };
    if (it.type === "message" && Array.isArray(it.content)) {
      for (const part of it.content) {
        if (!part || typeof part !== "object") continue;
        const p = part as { type?: string; text?: string };
        if (p.type === "output_text" && typeof p.text === "string") content += p.text;
      }
    } else if (it.type === "function_call") {
      toolCalls.push({
        id: it.call_id ?? it.id ?? `call_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
        type: "function",
        function: { name: it.name ?? "", arguments: it.arguments ?? "" },
      });
    }
  }
  return { content, toolCalls };
}

export function buildChatCompletion(
  finalResponse: CodexResponse,
  outputItems: unknown[],
  requestedModel: string,
): Record<string, unknown> {
  const { content, toolCalls } = assembleChoice(outputItems);
  const message: Record<string, unknown> = { role: "assistant" };
  if (toolCalls.length > 0) {
    message.content = null;
    message.tool_calls = toolCalls;
  } else {
    message.content = content;
  }
  const finishReason = determineFinishReason(finalResponse, toolCalls.length > 0);
  const usage = finalResponse.usage;
  return {
    id: makeChatId(finalResponse.id),
    object: "chat.completion",
    created:
      typeof finalResponse.created_at === "number"
        ? finalResponse.created_at
        : Math.floor(Date.now() / 1000),
    model: finalResponse.model ?? requestedModel,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: toChatCompletionUsage(usage),
  };
}

export interface ChatCompletionResultOk {
  ok: Record<string, unknown>;
}
export interface ChatCompletionResultErr {
  error: { status: number; message: string };
}
export type ChatCompletionResult = ChatCompletionResultOk | ChatCompletionResultErr;

export async function collectChatCompletion(
  upstreamRes: Response,
  requestedModel: string,
): Promise<ChatCompletionResult> {
  if (!upstreamRes.ok || !upstreamRes.body) {
    const detail = await upstreamRes.text().catch(() => "");
    let message = detail || `upstream HTTP ${upstreamRes.status}`;
    try {
      const parsed = JSON.parse(detail) as { detail?: string; message?: string };
      message = parsed.detail ?? parsed.message ?? message;
    } catch {
      // not JSON
    }
    return { error: { status: upstreamRes.status, message } };
  }

  let finalResponse: CodexResponse | null = null;
  let lastError: string | null = null;
  const outputItems: Record<number, unknown> = {};
  for await (const ev of parseSse(upstreamRes.body)) {
    if (!ev.data || ev.data === "[DONE]") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(ev.data);
    } catch {
      continue;
    }
    const obj = parsed as {
      type?: string;
      response?: CodexResponse;
      item?: unknown;
      output_index?: number;
      error?: { message?: string };
    };
    if (obj.type === "response.output_item.done" && obj.item !== undefined) {
      const idx = typeof obj.output_index === "number" ? obj.output_index : 0;
      outputItems[idx] = obj.item;
    } else if (obj.type === "response.completed" && obj.response) {
      finalResponse = obj.response;
    } else if (obj.type === "response.failed" || obj.type === "error") {
      const innerErr =
        ((obj.response as unknown) as { error?: { message?: string } } | undefined)?.error ?? obj.error;
      lastError = innerErr?.message ?? "upstream stream failed";
    }
  }

  if (!finalResponse) {
    return { error: { status: 502, message: lastError ?? "no completed response received" } };
  }

  const collected = Object.keys(outputItems)
    .map((k) => Number(k))
    .sort((a, b) => a - b)
    .map((k) => outputItems[k]);

  return { ok: buildChatCompletion(finalResponse, collected, requestedModel) };
}
