export interface SseEvent {
  event?: string;
  data: string;
}

/**
 * Async iterator over an HTTP body Readable stream, yielding parsed SSE events.
 * Implements the minimum slice of the SSE spec that the OpenAI Responses API uses:
 *   - lines separated by `\n` or `\r\n`
 *   - events separated by a blank line
 *   - `event: <name>` and `data: <payload>` fields
 *   - multi-line `data:` is concatenated with newlines
 */
export async function* parseSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent, void, unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let event: string | undefined;
  let data: string[] = [];

  const flush = (): SseEvent | null => {
    if (data.length === 0 && event === undefined) return null;
    const out: SseEvent = { event, data: data.join("\n") };
    event = undefined;
    data = [];
    return out;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        let line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line === "") {
          const ev = flush();
          if (ev) yield ev;
          continue;
        }
        if (line.startsWith(":")) continue; // comment
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        let value2 = colon === -1 ? "" : line.slice(colon + 1);
        if (value2.startsWith(" ")) value2 = value2.slice(1);
        if (field === "event") event = value2;
        else if (field === "data") data.push(value2);
        // ignore id, retry — we don't reconnect
      }
    }
    // flush remaining buffered line if the server omitted the trailing newline
    if (buffer.length > 0) {
      const trailing = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
      if (trailing.length > 0 && !trailing.startsWith(":")) {
        const colon = trailing.indexOf(":");
        const field = colon === -1 ? trailing : trailing.slice(0, colon);
        let value2 = colon === -1 ? "" : trailing.slice(colon + 1);
        if (value2.startsWith(" ")) value2 = value2.slice(1);
        if (field === "event") event = value2;
        else if (field === "data") data.push(value2);
      }
      const ev = flush();
      if (ev) yield ev;
    } else {
      const ev = flush();
      if (ev) yield ev;
    }
  } finally {
    reader.releaseLock();
  }
}
