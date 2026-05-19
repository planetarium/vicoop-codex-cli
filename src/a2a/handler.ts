import {
  A2XAgent,
  AgentExecutor,
  DefaultRequestHandler,
  InMemoryRunner,
  InMemoryTaskStore,
  StreamingMode,
} from "@a2x/sdk";
import { CodexAgent } from "./agent.js";
import { A2A_ROUTE_PATH } from "./agent-card.js";

interface A2ABundle {
  handler: DefaultRequestHandler;
  a2xAgent: A2XAgent;
}

let cached: A2ABundle | null = null;

export function getA2ABundle(baseUrl: string): A2ABundle {
  if (cached) return cached;

  const agent = new CodexAgent();
  const runner = new InMemoryRunner({ agent, appName: agent.name });
  const executor = new AgentExecutor({
    runner,
    runConfig: { streamingMode: StreamingMode.SSE },
  });
  const taskStore = new InMemoryTaskStore();

  const a2xAgent = new A2XAgent({ taskStore, executor, protocolVersion: "1.0" })
    .setName("vicoop-codex")
    .setDescription(
      "A2A proxy agent that calls the user's ChatGPT subscription via the ChatGPT Codex backend.",
    )
    .setVersion("0.1.0")
    .setDefaultUrl(`${baseUrl}${A2A_ROUTE_PATH}`)
    .setDefaultInputModes(["text/plain"])
    .setDefaultOutputModes(["text/plain"])
    .addSkill({
      id: "general-chat",
      name: "General Chat",
      description: "General-purpose conversation backed by ChatGPT (gpt-5.3-codex by default).",
      tags: ["chat", "general", "codex", "chatgpt"],
    })
    .setProvider({
      organization: "vicoop-codex-cli",
      url: "https://github.com/",
    });

  const handler = new DefaultRequestHandler(a2xAgent);
  cached = { handler, a2xAgent };
  return cached;
}
