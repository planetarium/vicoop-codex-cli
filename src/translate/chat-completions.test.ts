import { test } from "node:test";
import assert from "node:assert/strict";
import {
  determineFinishReason,
  collectChatCompletion,
} from "./chat-completions.js";

// Build a mock `/responses` SSE Response (non-streaming collect path) from a
// list of events, mirroring the upstream wire format collectChatCompletion
// consumes.
function sseResponse(events: unknown[]): Response {
  const enc = new TextEncoder();
  const frames = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode(frames));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

test("determineFinishReason: completed -> stop", () => {
  assert.equal(determineFinishReason({ status: "completed" }, false), "stop");
});

test("determineFinishReason: tool calls win over everything", () => {
  assert.equal(
    determineFinishReason(
      { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
      true,
    ),
    "tool_calls",
  );
});

test("determineFinishReason: incomplete(max_output_tokens) -> length", () => {
  assert.equal(
    determineFinishReason(
      { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
      false,
    ),
    "length",
  );
});

test("determineFinishReason: incomplete(content_filter) -> content_filter", () => {
  assert.equal(
    determineFinishReason(
      { status: "incomplete", incomplete_details: { reason: "content_filter" } },
      false,
    ),
    "content_filter",
  );
});

test("determineFinishReason: incomplete with unknown/absent reason -> length (never stop)", () => {
  assert.equal(determineFinishReason({ status: "incomplete" }, false), "length");
  assert.equal(
    determineFinishReason(
      { status: "incomplete", incomplete_details: { reason: "something_new" } },
      false,
    ),
    "length",
  );
});

test("collectChatCompletion: response.incomplete is a terminal (length + usage), not a 502", async () => {
  const res = sseResponse([
    { type: "response.created", response: { id: "resp_inc", model: "gpt-5.5" } },
    {
      type: "response.incomplete",
      response: {
        id: "resp_inc",
        model: "gpt-5.5",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        usage: { input_tokens: 123, output_tokens: 0, total_tokens: 123 },
      },
    },
  ]);

  const result = await collectChatCompletion(res, "gpt-5.5");
  assert.ok("ok" in result, "incomplete must not become an error");
  const ok = result.ok as {
    choices: Array<{ finish_reason: string; message: { content: unknown } }>;
    usage: Record<string, number>;
  };
  assert.equal(ok.choices[0].finish_reason, "length");
  // Empty content is preserved as "" (the caller decides how to surface it),
  // but the real usage flows through instead of being dropped.
  assert.equal(ok.choices[0].message.content, "");
  assert.deepEqual(ok.usage, {
    prompt_tokens: 123,
    completion_tokens: 0,
    total_tokens: 123,
  });
});
