/**
 * Deterministic mock engine.
 *
 * One source of truth for scenario behavior, implemented over AIRoute IR
 * chunks. It backs both the OpenAI-compatible HTTP provider (`app.ts`) and
 * the direct `Source` implementation (`source.ts`), so tests can target the
 * same semantics either in-process or over the wire.
 */
import { ReadableStream } from "node:stream/web";
import { UpstreamError, type IRChunk, type IRRequest } from "@airoute/core";

export const MOCK_SCENARIOS = [
  "echo",
  "stream-ok",
  "429-storm",
  "drop-mid-stream",
  "timeout",
  "bad-key",
] as const;

export type MockScenario = (typeof MOCK_SCENARIOS)[number];

/** How long the `timeout` scenario stalls before emitting its partial answer. */
export const MOCK_TIMEOUT_DELAY_MS = 3000;
/** Delay between two emitted content deltas. */
export const MOCK_CHUNK_DELAY_MS = 10;
/** Characters streamed per content delta. */
export const MOCK_CHUNK_SIZE_CHARS = 8;

export const MOCK_STREAM_OK_TEXT = "The quick brown fox jumps over the lazy dog.";

export interface MockEngine {
  readonly scenario: MockScenario;
  stream(request: IRRequest): Promise<ReadableStream<IRChunk>>;
}

export function normalizeScenario(raw: string | undefined): MockScenario {
  if (raw === undefined) return "echo";
  if (
    (MOCK_SCENARIOS as readonly string[]).includes(raw)
  ) {
    return raw as MockScenario;
  }
  return "echo";
}

/**
 * Build an engine for one scenario.
 *
 * - `echo`             — streams "ECHO: <last user message>", clean `stop`.
 * - `stream-ok`        — streams a fixed sentence, clean `stop`.
 * - `429-storm`        — the first three `stream()` calls reject with 429,
 *                        afterwards behaves like `echo`.
 * - `drop-mid-stream`  — emits a role chunk + a bit of text, then ends the
 *                        stream WITHOUT a finishReason (exercises the
 *                        gateway's synthesized "stop" chunk).
 * - `timeout`          — stalls ~3s, emits role + a partial text delta, then
 *                        ends without a finishReason (exercising timeouts and
 *                        the synthesis path in one go).
 * - `bad-key`          — rejects with 401 always.
 */
export function createMockEngine(options: { scenario?: string } = {}): MockEngine {
  const scenario = normalizeScenario(options.scenario);
  let streamCalls = 0;
  return {
    scenario,
    stream(request: IRRequest): Promise<ReadableStream<IRChunk>> {
      streamCalls += 1;
      switch (scenario) {
        case "bad-key":
          return Promise.reject(
            new UpstreamError("mock upstream: invalid api key", {
              status: 401,
              code: "invalid_api_key",
            }),
          );
        case "429-storm":
          if (streamCalls <= 3) {
            return Promise.reject(
              new UpstreamError("mock upstream: rate limited (first three calls fail)", {
                status: 429,
                code: "rate_limit_exceeded",
              }),
            );
          }
          return Promise.resolve(echoStream(request));
        case "stream-ok":
          return Promise.resolve(chunkedTextStream(MOCK_STREAM_OK_TEXT, { finish: true }));
        case "drop-mid-stream":
          return Promise.resolve(
            chunkedTextStream("partial data before the upstream vanished", { finish: false }),
          );
        case "timeout":
          return Promise.resolve(timeStalledStream());
        case "echo":
        default:
          return Promise.resolve(echoStream(request));
      }
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Streams                                                                    */
/* -------------------------------------------------------------------------- */

function echoStream(request: IRRequest): ReadableStream<IRChunk> {
  const users = request.messages.filter((message) => message.role === "user");
  const lastUser = users.length > 0 ? users[users.length - 1]?.content ?? "" : "";
  const text = `ECHO: ${lastUser}`;
  return chunkedTextStream(text, { finish: true });
}

interface TextStreamOptions {
  /** Emit a terminal `stop` chunk (false = stream simply ends). */
  finish: boolean;
}

function chunkedTextStream(text: string, options: TextStreamOptions): ReadableStream<IRChunk> {
  let offset = 0;
  let index = 0;
  return new ReadableStream<IRChunk>({
    async pull(controller) {
      if (index === 0) {
        controller.enqueue({ index: index++, role: "assistant" });
        await delay(MOCK_CHUNK_DELAY_MS);
        return;
      }
      if (offset >= text.length) {
        if (options.finish) {
          controller.enqueue({ index: index++, finishReason: "stop", done: true });
        }
        controller.close();
        return;
      }
      const piece = text.slice(offset, offset + MOCK_CHUNK_SIZE_CHARS);
      offset += MOCK_CHUNK_SIZE_CHARS;
      controller.enqueue({ index: index++, content: piece });
      await delay(MOCK_CHUNK_DELAY_MS);
    },
  });
}

function timeStalledStream(): ReadableStream<IRChunk> {
  let stage = 0;
  let index = 0;
  return new ReadableStream<IRChunk>({
    async pull(controller) {
      if (stage === 0) {
        stage = 1;
        await delay(MOCK_TIMEOUT_DELAY_MS);
        controller.enqueue({ index: index++, role: "assistant" });
        return;
      }
      if (stage === 1) {
        stage = 2;
        controller.enqueue({ index: index++, content: "partial data after a long stall" });
        return;
      }
      // End abruptly, without a finishReason: the gateway synthesizes "stop".
      controller.close();
    },
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
