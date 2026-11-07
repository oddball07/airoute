/**
 * Incremental, pull-based SSE plumbing for the openai-compat kit.
 *
 * Deliberately low-level and dependency-free:
 * - Lines are produced lazily from the upstream byte stream (`read()`-driven),
 *   so a stream consumer that only pulls one chunk at a time never buffers the
 *   whole upstream response in memory.
 * - `awaitWithTimeout` races any promise against an idle timeout so a wedged
 *   upstream surfaces as a 504-style failure instead of hanging forever.
 */
export class SseTimeoutError extends Error {
  override readonly name = "SseTimeoutError";
}

/** True for a usable positive finite timeout, false for "no timeout". */
export function isPositiveTimeout(ms: number | undefined): ms is number {
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0;
}

/**
 * Await `promise`, but reject with `SseTimeoutError` after `timeoutMs`.
 * `onTimeout` (optional) is called first — e.g. to abort the underlying
 * fetch so the network request does not keep running.
 */
export async function awaitWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number | undefined,
  onTimeout?: (err: SseTimeoutError) => void,
): Promise<T> {
  if (!isPositiveTimeout(timeoutMs)) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gate = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new SseTimeoutError(`operation exceeded ${timeoutMs}ms`);
      try {
        onTimeout?.(err);
      } catch {
        // A failing hook must not mask the timeout itself.
      }
      reject(err);
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, gate]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Iterate the upstream response body as UTF-8 text lines, incrementally.
 *
 * Each yielded line excludes the trailing `\n` (and a trailing `\r`, so CRLF
 * and LF streams behave identically). The final unterminated line is flushed.
 * Every read is raced against `timeoutMs` (idle timeout); a stall rejects the
 * generator — and therefore the consuming `for await` — with SseTimeoutError.
 */
export async function* readLines(
  body: ReadableStream<Uint8Array>,
  timeoutMs: number | undefined,
): AsyncGenerator<string, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const pending = reader.read();
      pending.catch(() => {}); // unhandled-rejection guard when we lose the timeout race
      const result = await awaitWithTimeout(pending, timeoutMs);
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        yield line.endsWith("\r") ? line.slice(0, -1) : line;
        newline = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0) {
      yield buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}
