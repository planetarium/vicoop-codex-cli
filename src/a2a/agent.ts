import { BaseAgent, type AgentEvent, type InvocationContext } from "@a2x/sdk";
import { postUpstream } from "../client/responses.js";
import { parseSse } from "../client/sse.js";

const DEFAULT_MODEL = "gpt-5.3-codex";
const DEFAULT_INSTRUCTIONS = "You are a helpful assistant.";

function findLatestUserText(events: AgentEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type === "text" && ev.role === "user") return ev.text;
  }
  return "";
}

function buildUpstreamBody(userText: string): Record<string, unknown> {
  return {
    model: DEFAULT_MODEL,
    instructions: DEFAULT_INSTRUCTIONS,
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: userText }],
      },
    ],
    tools: [],
    tool_choice: "auto",
    parallel_tool_calls: false,
    store: false,
    stream: true,
    include: [],
  };
}

export class CodexAgent extends BaseAgent {
  constructor() {
    super({
      name: "codex_vicoop_agent",
      description:
        "Proxies A2A requests to the user's ChatGPT subscription via the ChatGPT Codex backend.",
    });
  }

  async *run(ctx: InvocationContext): AsyncGenerator<AgentEvent> {
    const userText = findLatestUserText(ctx.session.events ?? []);

    let upstreamRes: Response;
    try {
      upstreamRes = await postUpstream(buildUpstreamBody(userText), ctx.signal);
    } catch (err) {
      yield {
        type: "text",
        role: "agent",
        text: `[upstream error] ${(err as Error).message ?? String(err)}`,
      };
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
