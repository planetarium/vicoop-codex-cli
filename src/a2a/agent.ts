import { BaseAgent, type AgentEvent, type InvocationContext, type Message } from "@a2x/sdk";
import { postUpstream } from "../client/responses.js";
import { resolveDefaultModel } from "../client/models.js";
import { parseSse } from "../client/sse.js";
import {
  chatCompletionsToUpstream,
  type ChatCompletionsBody,
} from "../translate/chat-completions.js";

function findLatestUserText(events: AgentEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type === "text" && ev.role === "user") return ev.text;
  }
  return "";
}

/**
 * Pull a Chat Completions body out of the A2A message metadata, if present.
 *
 * Convention: A2A clients put a complete OpenAI Chat Completions body
 * (model / messages / tools / tool_choice / etc.) into `message.metadata`.
 * The user's A2A `parts` text is then largely advisory — the actual
 * request to the backend is whatever metadata says.
 *
 * The @a2x/sdk's Runner injects the raw `message` onto `InvocationContext`
 * at runtime even though the TS type doesn't expose it, so we cast.
 */
function buildChatBody(ctx: InvocationContext): {
  body: ChatCompletionsBody;
  source: "metadata-full" | "metadata-partial" | "user-text";
} {
  const message = (ctx as InvocationContext & { message?: Message }).message;
  const metadata = message?.metadata as ChatCompletionsBody | undefined;

  // Case A: metadata carries a complete Chat Completions body (with messages array).
  // Use it verbatim — the user-message text in `parts` is ignored.
  if (metadata && Array.isArray(metadata.messages) && metadata.messages.length > 0) {
    return { body: metadata, source: "metadata-full" };
  }

  // Case B: metadata is present but no messages array. Build a minimal body
  // from the latest user-text event, and merge in any other top-level
  // metadata fields (model, tools, reasoning_effort, etc.).
  const userText = findLatestUserText(ctx.session.events ?? []);
  const body: ChatCompletionsBody = {
    messages: [{ role: "user", content: userText }],
  };

  if (metadata && typeof metadata === "object") {
    for (const k of Object.keys(metadata)) {
      if (k === "messages") continue;
      const v = (metadata as Record<string, unknown>)[k];
      if (v !== undefined) (body as Record<string, unknown>)[k] = v;
    }
    return { body, source: "metadata-partial" };
  }

  return { body, source: "user-text" };
}

export class CodexAgent extends BaseAgent {
  constructor() {
    super({
      name: "codex_vicoop_agent",
      description:
        "Proxies A2A requests to the user's ChatGPT subscription via the ChatGPT Codex backend. Pass a full Chat Completions body in Message.metadata to control model/tools/etc.",
    });
  }

  async *run(ctx: InvocationContext): AsyncGenerator<AgentEvent> {
    const { body, source } = buildChatBody(ctx);

    if (!body.model) {
      try {
        body.model = await resolveDefaultModel();
      } catch (err) {
        yield {
          type: "text",
          role: "agent",
          text: `[upstream error] ${(err as Error).message ?? String(err)}`,
        };
        yield { type: "done" };
        return;
      }
    }

    const { upstream, dropped } = chatCompletionsToUpstream(body);

    const stamp = new Date().toISOString();
    process.stderr.write(`[${stamp}] a2a request (source=${source})\n`);
    process.stderr.write(JSON.stringify(body, null, 2) + "\n");
    if (dropped.length > 0) {
      process.stderr.write(
        `[${stamp}] a2a: dropped unsupported fields: ${dropped.join(", ")}\n`,
      );
    }

    let upstreamRes: Response;
    try {
      upstreamRes = await postUpstream(upstream, ctx.signal);
    } catch (err) {
      yield {
        type: "text",
        role: "agent",
        text: `[upstream error] ${(err as Error).message ?? String(err)}`,
      };
      yield { type: "done" };
      return;
    }

    if (!upstreamRes.ok || !upstreamRes.body) {
      const detail = await upstreamRes.text().catch(() => "");
      let message = detail || `upstream HTTP ${upstreamRes.status}`;
      try {
        const parsed = JSON.parse(detail) as { detail?: string; message?: string };
        message = parsed.detail ?? parsed.message ?? message;
      } catch {
        // not JSON
      }
      yield { type: "text", role: "agent", text: `[upstream error] ${message}` };
      yield { type: "done" };
      return;
    }

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
        delta?: string;
        error?: { message?: string };
        response?: { error?: { message?: string } };
      };
      if (obj.type === "response.output_text.delta" && typeof obj.delta === "string") {
        yield { type: "text", role: "agent", text: obj.delta };
      } else if (obj.type === "response.failed" || obj.type === "error") {
        const msg =
          obj.response?.error?.message ?? obj.error?.message ?? "upstream stream failed";
        yield { type: "text", role: "agent", text: `[upstream error] ${msg}` };
        yield { type: "done" };
        return;
      }
    }

    yield { type: "done" };
  }
}
