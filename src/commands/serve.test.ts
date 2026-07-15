import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  streamChatCompletion,
  wireClientAbort,
  startParentDeathWatch,
  type StreamSink,
} from "./serve.js";

// A setInterval seam that captures the tick handler so tests can drive it
// deterministically, and records unref()/clearInterval calls.
function fakeInterval() {
  let handler: (() => void) | null = null;
  let unrefCalls = 0;
  let cleared = false;
  const timer = {
    unref() {
      unrefCalls++;
      return timer;
    },
  } as unknown as NodeJS.Timeout;
  const setIntervalFn = (h: () => void, _ms: number): NodeJS.Timeout => {
    handler = h;
    return timer;
  };
  return {
    setIntervalFn,
    tick: () => handler?.(),
    timer,
    get unrefCalls() {
      return unrefCalls;
    },
    get cleared() {
      return cleared;
    },
    markCleared: () => {
      cleared = true;
    },
  };
}

test("startParentDeathWatch fires onOrphan once when ppid changes", () => {
  const fi = fakeInterval();
  let ppid = 42;
  let orphaned = 0;
  const watch = startParentDeathWatch({
    initialPpid: 42,
    onOrphan: () => orphaned++,
    getPpid: () => ppid,
    setIntervalFn: fi.setIntervalFn,
  });
  assert.ok(watch, "watch should be installed for a real parent");
  assert.equal(fi.unrefCalls, 1, "timer must be unref'd");

  fi.tick(); // ppid unchanged -> no fire
  assert.equal(orphaned, 0);

  ppid = 1; // reparented to init: parent is gone
  fi.tick();
  assert.equal(orphaned, 1);

  fi.tick(); // stays fired: never double-fire
  assert.equal(orphaned, 1);
});

test("startParentDeathWatch also fires when reparented to a subreaper (ppid changes, not 1)", () => {
  const fi = fakeInterval();
  let ppid = 42;
  let orphaned = 0;
  startParentDeathWatch({
    initialPpid: 42,
    onOrphan: () => orphaned++,
    getPpid: () => ppid,
    setIntervalFn: fi.setIntervalFn,
  });
  ppid = 999; // a subreaper, not init
  fi.tick();
  assert.equal(orphaned, 1);
});

test("startParentDeathWatch is a no-op when disabled", () => {
  const fi = fakeInterval();
  const watch = startParentDeathWatch({
    initialPpid: 42,
    enabled: false,
    onOrphan: () => assert.fail("should not fire"),
    getPpid: () => 1,
    setIntervalFn: fi.setIntervalFn,
  });
  assert.equal(watch, null);
});

test("startParentDeathWatch is a no-op when already an orphan (ppid <= 1)", () => {
  const fi = fakeInterval();
  const watch = startParentDeathWatch({
    initialPpid: 1,
    onOrphan: () => assert.fail("should not fire"),
    getPpid: () => 1,
    setIntervalFn: fi.setIntervalFn,
  });
  assert.equal(watch, null);
});

test("startParentDeathWatch stop() clears the timer", () => {
  const fi = fakeInterval();
  const watch = startParentDeathWatch({
    initialPpid: 42,
    onOrphan: () => assert.fail("stopped watch must not fire"),
    getPpid: () => 42,
    setIntervalFn: fi.setIntervalFn,
  });
  assert.ok(watch);
  watch.stop(); // must not throw; timer handle passed to clearInterval
});

// Build a ReadableStream<Uint8Array> from a list of Responses-API SSE events.
// Each event is serialized as a `data: <json>\n\n` frame, matching the upstream
// `/responses` wire format that parseSse consumes.
function sseStream(events: unknown[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const frames = events
    .map((e) => `data: ${JSON.stringify(e)}\n\n`)
    .join("");
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode(frames));
      controller.close();
    },
  });
}

// Minimal StreamSink that records every frame written.
function fakeSink(): StreamSink & { frames: string[]; ended: boolean } {
  const frames: string[] = [];
  return {
    frames,
    ended: false,
    headersSent: true, // emulate streaming path (headers already written)
    writableEnded: false,
    write(chunk: string) {
      frames.push(chunk);
      return true;
    },
    end() {
      (this as { ended: boolean }).ended = true;
      return undefined;
    },
    writeHead() {
      return undefined;
    },
  };
}

// Parse the `data: {...}` SSE frames a sink captured into chat.completion.chunk
// objects (dropping the terminal `[DONE]`).
function parseChunks(frames: string[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const f of frames) {
    const line = f.replace(/^data: /, "").trim();
    if (line === "[DONE]") continue;
    out.push(JSON.parse(line));
  }
  return out;
}

function deltaOf(chunk: Record<string, unknown>): Record<string, unknown> {
  const choices = chunk.choices as Array<{ delta: Record<string, unknown>; finish_reason: unknown }>;
  return choices[0].delta;
}

test("streamChatCompletion relays reasoning_summary deltas as delta.reasoning_content", async () => {
  const sink = fakeSink();
  await streamChatCompletion(
    sseStream([
      { type: "response.created", response: { id: "resp_abc", model: "gpt-5.5" } },
      { type: "response.reasoning_summary_text.delta", delta: "Let me " },
      { type: "response.reasoning_summary_text.delta", delta: "think." },
      { type: "response.output_text.delta", delta: "Hello" },
      { type: "response.output_text.delta", delta: " world" },
      {
        type: "response.completed",
        response: {
          status: "completed",
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        },
      },
    ]),
    sink,
    "gpt-5.5",
    true,
  );

  const chunks = parseChunks(sink.frames);

  // Role chunk first, then reasoning, then content — interleaving preserved.
  const reasoning = chunks
    .map(deltaOf)
    .filter((d) => "reasoning_content" in d)
    .map((d) => d.reasoning_content);
  assert.deepEqual(reasoning, ["Let me ", "think."]);

  const content = chunks
    .map(deltaOf)
    .filter((d) => "content" in d && d.content !== "" && d.content !== null)
    .map((d) => d.content);
  assert.deepEqual(content, ["Hello", " world"]);

  // No reasoning text leaks into any delta.content.
  for (const d of chunks.map(deltaOf)) {
    if ("content" in d && typeof d.content === "string") {
      assert.ok(!d.content.includes("Let me"));
      assert.ok(!d.content.includes("think."));
    }
  }

  // The first emitted chunk is the assistant role chunk.
  assert.deepEqual(deltaOf(chunks[0]), { role: "assistant", content: "" });

  // Reasoning is emitted before content (ordering preserved from the stream).
  const firstReasoningIdx = chunks.findIndex((c) => "reasoning_content" in deltaOf(c));
  const firstContentIdx = chunks.findIndex((c) => {
    const d = deltaOf(c);
    return "content" in d && d.content === "Hello";
  });
  assert.ok(firstReasoningIdx < firstContentIdx);

  // Final chunk carries finish_reason=stop and usage; finish-reason logic is
  // unaffected by reasoning.
  const final = chunks[chunks.length - 1];
  const finalChoice = (final.choices as Array<{ finish_reason: unknown }>)[0];
  assert.equal(finalChoice.finish_reason, "stop");
  assert.deepEqual(final.usage, {
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
  });
});

test("streamChatCompletion inserts a blank-line separator between reasoning parts", async () => {
  const sink = fakeSink();
  await streamChatCompletion(
    sseStream([
      { type: "response.created", response: { id: "resp_x", model: "gpt-5.5" } },
      { type: "response.reasoning_summary_part.added" }, // before first part: no separator
      { type: "response.reasoning_summary_text.delta", delta: "part one" },
      { type: "response.reasoning_summary_part.added" }, // after first part: separator
      { type: "response.reasoning_summary_text.delta", delta: "part two" },
      { type: "response.completed", response: { status: "completed" } },
    ]),
    sink,
    "gpt-5.5",
    false,
  );

  const reasoning = parseChunks(sink.frames)
    .map(deltaOf)
    .filter((d) => "reasoning_content" in d)
    .map((d) => d.reasoning_content);

  // No separator before the first part; one "\n\n" between the two parts.
  assert.deepEqual(reasoning, ["part one", "\n\n", "part two"]);
});

test("streamChatCompletion keeps finish_reason=tool_calls with reasoning present", async () => {
  const sink = fakeSink();
  await streamChatCompletion(
    sseStream([
      { type: "response.created", response: { id: "resp_t", model: "gpt-5.5" } },
      { type: "response.reasoning_summary_text.delta", delta: "deciding" },
      {
        type: "response.output_item.done",
        item: { type: "function_call", call_id: "call_1", name: "get_time", arguments: "{}" },
      },
      { type: "response.completed", response: { status: "completed" } },
    ]),
    sink,
    "gpt-5.5",
    false,
  );

  const chunks = parseChunks(sink.frames);
  const reasoning = chunks
    .map(deltaOf)
    .filter((d) => "reasoning_content" in d)
    .map((d) => d.reasoning_content);
  assert.deepEqual(reasoning, ["deciding"]);

  const toolCallChunk = chunks.find((c) => "tool_calls" in deltaOf(c));
  assert.ok(toolCallChunk, "expected a tool_calls chunk");

  const final = chunks[chunks.length - 1];
  const finalChoice = (final.choices as Array<{ finish_reason: unknown }>)[0];
  assert.equal(finalChoice.finish_reason, "tool_calls");
});

test("streamChatCompletion maps response.incomplete(max_output_tokens) to finish_reason=length with usage", async () => {
  const sink = fakeSink();
  await streamChatCompletion(
    sseStream([
      { type: "response.created", response: { id: "resp_inc", model: "gpt-5.5" } },
      // The model spent its whole output budget reasoning and emitted no
      // output_text — the exact empty-response failure mode. Upstream closes
      // with `response.incomplete`, not `response.completed`.
      { type: "response.reasoning_summary_text.delta", delta: "thinking hard" },
      {
        type: "response.incomplete",
        response: {
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          usage: { input_tokens: 400000, output_tokens: 8000, total_tokens: 408000 },
        },
      },
    ]),
    sink,
    "gpt-5.5",
    true,
  );

  const chunks = parseChunks(sink.frames);
  const final = chunks[chunks.length - 1];
  const finalChoice = (final.choices as Array<{ finish_reason: unknown }>)[0];
  // Was previously mislabeled "stop" with no usage — the empty-response bug.
  assert.equal(finalChoice.finish_reason, "length");
  assert.deepEqual(final.usage, {
    prompt_tokens: 400000,
    completion_tokens: 8000,
    total_tokens: 408000,
  });
});

test("streamChatCompletion maps response.incomplete(content_filter) to finish_reason=content_filter", async () => {
  const sink = fakeSink();
  await streamChatCompletion(
    sseStream([
      { type: "response.created", response: { id: "resp_cf", model: "gpt-5.5" } },
      {
        type: "response.incomplete",
        response: {
          status: "incomplete",
          incomplete_details: { reason: "content_filter" },
        },
      },
    ]),
    sink,
    "gpt-5.5",
    true,
  );

  const chunks = parseChunks(sink.frames);
  const final = chunks[chunks.length - 1];
  const finalChoice = (final.choices as Array<{ finish_reason: unknown }>)[0];
  assert.equal(finalChoice.finish_reason, "content_filter");
});

test("wireClientAbort aborts on a premature client close (before response ends)", () => {
  const req = new EventEmitter();
  const res = Object.assign(new EventEmitter(), { writableEnded: false });
  const signal = wireClientAbort(req, res as never);

  assert.equal(signal.aborted, false);
  req.emit("close"); // client vanished mid-request
  assert.equal(signal.aborted, true, "a premature close must abort the upstream signal");
});

test("wireClientAbort does NOT abort when the response already finished", () => {
  const req = new EventEmitter();
  const res = Object.assign(new EventEmitter(), { writableEnded: true });
  const signal = wireClientAbort(req, res as never);

  // Normal end-of-response: res 'close' fires after res.end(), writableEnded=true.
  res.emit("close");
  req.emit("close");
  assert.equal(signal.aborted, false, "a normal completion must not abort");
});

test("wireClientAbort reacts to the legacy req 'aborted' event too", () => {
  const req = new EventEmitter();
  const res = Object.assign(new EventEmitter(), { writableEnded: false });
  const signal = wireClientAbort(req, res as never);

  req.emit("aborted");
  assert.equal(signal.aborted, true);
});

test("chatCompletionsToUpstream requests reasoning.summary=auto", async () => {
  const { chatCompletionsToUpstream } = await import("../translate/chat-completions.js");
  const { upstream } = chatCompletionsToUpstream({
    model: "gpt-5.5",
    messages: [{ role: "user", content: "hi" }],
    reasoning_effort: "high",
  });
  assert.deepEqual(upstream.reasoning, { effort: "high", summary: "auto" });
});
