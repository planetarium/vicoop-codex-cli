import { randomUUID } from "node:crypto";
import { parseSse } from "../client/sse.js";

export const DEFAULT_MODEL = "gpt-5.3-codex";
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
}

export interface CodexResponse {
  id?: string;
  created_at?: number;
  model?: string;
  usage?: CodexUsage;
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
]);

export const CHAT_FIELDS_CONSUMED = new Set([
  "model",
  "messages",
  "stream",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "reasoning_effort",
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

  for (const msg of body.messages ?? []) {
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

  let toolChoice: unknown = body.tool_choice ?? "auto";
  if (toolChoice && typeof toolChoice === "object") {
    const tc = toolChoice as { type?: string; function?: { name?: string } };
    if (tc.type === "function" && tc.function?.name) {
      toolChoice = { type: "function", name: tc.function.name };
    }
  }

  const candidate: Record<string, unknown> = {
    model: body.model ?? DEFAULT_MODEL,
    instructions: systemTexts.length > 0 ? systemTexts.join("\n\n") : DEFAULT_INSTRUCTIONS,
    input: inputItems,
    tools,
    tool_choice: toolChoice,
    parallel_tool_calls: body.parallel_tool_calls ?? false,
    store: false,
    stream: true,
    include: [],
  };

  if (typeof body.reasoning_effort === "string") {
    candidate.reasoning = { effort: body.reasoning_effort };
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
  const finishReason = toolCalls.length > 0 ? "tool_calls" : "stop";
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
    usage: {
      prompt_tokens: usage?.input_tokens ?? 0,
      completion_tokens: usage?.output_tokens ?? 0,
      total_tokens: usage?.total_tokens ?? 0,
    },
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
