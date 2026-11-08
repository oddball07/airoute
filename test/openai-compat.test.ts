/**
 * Unit tests for the openai-compat kit — fully synthetic (injected `fetch`,
 * no real network, no mock provider server). The zai-side and end-to-end
 * tests against the running mock provider live in the other test files.
 */
import { UpstreamError, type IRChunk, type IRRequest } from "@airoute/core";
import {
  DEFAULT_OPENAI_COMPAT_TIMEOUT_MS,
  SseTimeoutError,
  createOpenAICompatSource,
  validateBaseUrl,
  validateSourceModelDefs,
  validateTimeoutMs,
  type OpenAICompatOptions,
} from "@airoute/openai-compat";
import { describe, expect, it } from "vitest";

/* -------------------------------------------------------------------------- */
/* Test seams                                                                 */
/* -------------------------------------------------------------------------- */

interface CapturedRequest {
  url: string;
  init?: RequestInit;
}

function fakeFetch(
  responder: (request: CapturedRequest) => Response | Promise<Response>,
): { fetch: typeof fetch; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const captured: CapturedRequest = { url, init };
    requests.push(captured);
    return responder(captured);
  }) as typeof fetch;
  return { fetch: fetchFn, requests };
}

/** SSE response from raw lines (chunks joined with "\n"). */
function sse(...lines: string[]): Response {
  return new Response(lines.join("\n"), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** One OpenAI-style data line. */
function data(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}`;
}

/** An OpenAI chat.completion.chunk in its wire form. */
function wireChunk(opts: {
  index?: number;
  role?: string;
  content?: string;
  finish?: string | null;
  toolCalls?: unknown[];
}): string {
  const delta: Record<string, unknown> = {};
  if (opts.role !== undefined) delta["role"] = opts.role;
  if (opts.content !== undefined) delta["content"] = opts.content;
  if (opts.toolCalls !== undefined) delta["tool_calls"] = opts.toolCalls;
  return data({
    id: "c1",
    object: "chat.completion.chunk",
    created: 0,
    model: "m1",
    choices: [
      { index: opts.index ?? 0, delta, finish_reason: opts.finish ?? null },
    ],
  });
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface KitHarness {
  source: ReturnType<typeof createOpenAICompatSource>;
  requests: CapturedRequest[];
}

function kit(
  responder: (request: CapturedRequest) => Response | Promise<Response>,
  overrides: Partial<OpenAICompatOptions> = {},
): KitHarness {
  const { fetch, requests } = fakeFetch(responder);
  const source = createOpenAICompatSource({
    id: "kit",
    baseUrl: "https://kit.test/api/v4",
    apiKey: "k-test",
    models: [{ id: "m1", label: "Model One", contextWindow: 1_000, aliases: ["m-one"] }],
    timeoutMs: 250,
    fetch,
    ...overrides,
  });
  return { source, requests };
}

/** Default (happy) upstream: role, two content chunks, finish, DONE. */
function echoResponder(): Response {
  return sse(
    wireChunk({ role: "assistant" }),
    wireChunk({ content: "Hello" }),
    wireChunk({ content: " world" }),
    wireChunk({ finish: "stop" }),
    "data: [DONE]",
    "",
  );
}

async function readAll(stream: ReadableStream<IRChunk>): Promise<IRChunk[]> {
  const reader = stream.getReader();
  const out: IRChunk[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
}

const probeRequest: IRRequest = {
  model: "kit/m1",
  messages: [{ role: "user", content: "hello" }],
};

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe("createOpenAICompatSource — listModels", () => {
  it("maps the static list onto ModelSpecs with ids '<sourceId>/<def.id>'", async () => {
    const { source } = kit(echoResponder);
    const specs = await source.listModels();
    expect(specs).toHaveLength(1);
    const spec = specs[0]!;
    expect(spec.id).toBe("kit/m1");
    expect(spec.sourceId).toBe("kit");
    expect(spec.sourceModelId).toBe("m1");
    expect(spec.label).toBe("Model One");
    expect(spec.contextWindow).toBe(1_000);
    expect(spec.free).toBe(true);
    expect(spec.aliases).toEqual(["m-one"]);
    expect(spec.caps).toEqual({ tools: true, vision: false, reasoning: false });
    // light + documented meta
    expect(spec.meta).toEqual({
      contextWindow: 1_000,
      raw: { id: "m1", label: "Model One", contextWindow: 1_000, aliases: ["m-one"] },
    });
  });

  it("defaults: label = def.id, contextWindow = 0, caps, aliases = []", async () => {
    const { source } = kit(echoResponder, {
      models: [{ id: "bare", caps: { vision: true } }],
    });
    const spec = (await source.listModels())[0]!;
    expect(spec.id).toBe("kit/bare");
    expect(spec.label).toBe("bare");
    expect(spec.contextWindow).toBe(0);
    expect(spec.caps).toEqual({ tools: true, vision: true, reasoning: false });
    expect(spec.aliases).toEqual([]);
    expect(spec.meta).toEqual({ contextWindow: 0, raw: { id: "bare", caps: { vision: true } } });
  });
});

describe("createOpenAICompatSource — stream (request shape)", () => {
  it("POSTs ${baseUrl}/chat/completions with Bearer auth and stream:true", async () => {
    const { source, requests } = kit(echoResponder);
    const spec = (await source.listModels())[0]!;
    const stream = await source.stream({
      model: spec,
      request: { ...probeRequest, stream: false }, // caller's choice is ignored upstream
    });
    await readAll(stream);

    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.url).toBe("https://kit.test/api/v4/chat/completions");
    expect(request.init?.method).toBe("POST");
    const headers = request.init?.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer k-test");
    expect(headers["content-type"]).toBe("application/json");
    const body = JSON.parse(request.init?.body as string) as Record<string, unknown>;
    expect(body["model"]).toBe("m1"); // sourceModelId, not the gateway id
    expect(body["stream"]).toBe(true); // ALWAYS true upstream (kit contract)
    expect(Array.isArray(body["messages"])).toBe(true);
  });

  it("omits the Authorization header when no apiKey is set", async () => {
    const { source, requests } = kit(echoResponder, { apiKey: undefined });
    const spec = (await source.listModels())[0]!;
    const stream = await source.stream({ model: spec, request: probeRequest });
    await readAll(stream);
    const headers = (requests[0]!.init?.headers ?? {}) as Record<string, string>;
    expect(headers["authorization"]).toBeUndefined();
  });
});

describe("createOpenAICompatSource — stream (SSE → IR)", () => {
  it("attaches toolCall deltas to IR chunks and keeps role/finish bookkeeping", async () => {
    const { source } = kit(() =>
      sse(
        wireChunk({ role: "assistant" }),
        wireChunk({
          content: "",
          toolCalls: [{ index: 0, id: "call_x", type: "function", function: { name: "get_weather", arguments: "{\"loc" } }],
        }),
        wireChunk({
          toolCalls: [{ index: 0, function: { arguments: "ation\":\"Paris\"}" } }],
        }),
        wireChunk({ finish: "tool_calls" }),
        "data: [DONE]",
        "",
      ),
    );
    const spec = (await source.listModels())[0]!;
    const chunks = await readAll(await source.stream({ model: spec, request: probeRequest }));

    expect(chunks[0]).toMatchObject({ index: 0, role: "assistant" });
    expect(chunks[1]!.toolCalls).toEqual([
      { index: 0, id: "call_x", name: "get_weather", arguments: "{\"loc" },
    ]);
    expect(chunks[2]!.toolCalls).toEqual([{ index: 0, arguments: "ation\":\"Paris\"}" }]);
    const last = chunks[chunks.length - 1]!;
    expect(last).toMatchObject({ finishReason: "tool_calls", done: true });
    chunks.forEach((chunk, i) => expect(chunk.index).toBe(i));
  });

  it("emits delta.tool_calls when converting a non-stream tool-call completion body to a chunk stream", async () => {
    const { source } = kit(() =>
      json({
        id: "c11",
        object: "chat.completion",
        created: 0,
        model: "m1",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                { id: "call_w", type: "function", function: { name: "get_weather", arguments: "{}" } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    );
    const spec = (await source.listModels())[0]!;
    const chunks = await readAll(await source.stream({ model: spec, request: probeRequest }));

    expect(chunks[0]).toMatchObject({ index: 0, role: "assistant" });
    expect(chunks[1]!.toolCalls).toEqual([{ index: 0, id: "call_w", name: "get_weather", arguments: "{}" }]);
    const last = chunks[chunks.length - 1]!;
    expect(last).toMatchObject({ index: 2, finishReason: "tool_calls", done: true });
  });

  it("maps SSE chunks into ordered IRChunks and terminates with finish+done", async () => {
    const { source } = kit(echoResponder);
    const spec = (await source.listModels())[0]!;
    const chunks = await readAll(await source.stream({ model: spec, request: probeRequest }));

    expect(chunks[0]).toMatchObject({ index: 0, role: "assistant" });
    expect(chunks.flatMap((c) => c.content ?? []).join("")).toBe("Hello world");
    const last = chunks[chunks.length - 1]!;
    expect(last).toMatchObject({ finishReason: "stop", done: true });
    // sequential indices 0..n-1
    chunks.forEach((chunk, i) => expect(chunk.index).toBe(i));
  });

  it("ignores ': comment' keep-alive lines and tolerates CRLF endings", async () => {
    const { source } = kit(() => {
      return new Response(
        [": keep-alive ping", "", wireChunk({ role: "assistant" }), "", wireChunk({ finish: "stop" }), "", "data: [DONE]", ""].join(
          "\r\n",
        ),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    });
    const spec = (await source.listModels())[0]!;
    const chunks = await readAll(await source.stream({ model: spec, request: probeRequest }));
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({ index: 0, role: "assistant" });
    expect(chunks[1]).toMatchObject({ index: 1, finishReason: "stop", done: true });
  });

  it("injects role:'assistant' onto the first chunk when upstream omits it", async () => {
    const { source } = kit(() =>
      sse(
        // no leading role chunk — content arrives first
        wireChunk({ content: "hi" }),
        wireChunk({ finish: "length" }),
        "data: [DONE]",
        "",
      ),
    );
    const spec = (await source.listModels())[0]!;
    const chunks = await readAll(await source.stream({ model: spec, request: probeRequest }));
    expect(chunks[0]).toMatchObject({ index: 0, role: "assistant", content: "hi" });
    expect(chunks[1]).toMatchObject({ finishReason: "length", done: true });
  });

  it("drops role repeats later in the stream (role lives on the first chunk only)", async () => {
    const { source } = kit(() =>
      sse(
        wireChunk({ role: "assistant" }),
        wireChunk({ role: "assistant", content: "x" }),
        wireChunk({ finish: "stop" }),
        "data: [DONE]",
        "",
      ),
    );
    const spec = (await source.listModels())[0]!;
    const chunks = await readAll(await source.stream({ model: spec, request: probeRequest }));
    const roles = chunks.filter((c) => c.role !== undefined);
    expect(roles).toHaveLength(1);
    expect(chunks.flatMap((c) => c.content ?? []).join("")).toBe("x");
  });

  it("drops data lines sent after the finish chunk", async () => {
    const { source } = kit(() =>
      sse(
        wireChunk({ role: "assistant" }),
        wireChunk({ finish: "stop" }),
        data({ id: "usage", object: "chat.completion.chunk", choices: [] }), // straggler
        "data: [DONE]",
        "",
      ),
    );
    const spec = (await source.listModels())[0]!;
    const chunks = await readAll(await source.stream({ model: spec, request: probeRequest }));
    expect(chunks).toHaveLength(2); // role + terminal; straggler ignored
  });

  it("synthesizes a terminal 'stop' chunk when upstream ends without finish or [DONE]", async () => {
    const { source } = kit(() =>
      sse(wireChunk({ role: "assistant" }), wireChunk({ content: "partial" })),
    );
    const spec = (await source.listModels())[0]!;
    const chunks = await readAll(await source.stream({ model: spec, request: probeRequest }));
    expect(chunks).toHaveLength(3);
    expect(chunks[2]).toMatchObject({ finishReason: "stop", done: true });
  });

  it("emits nothing extra for an empty/SSE-less-but-clean stream", async () => {
    const { source } = kit(() => sse("data: [DONE]"));
    const spec = (await source.listModels())[0]!;
    const chunks = await readAll(await source.stream({ model: spec, request: probeRequest }));
    expect(chunks).toEqual([{ index: 0, finishReason: "stop", done: true }]);
  });
});

describe("createOpenAICompatSource — stream (lazy consumption = no whole-response buffering)", () => {
  it("reads upstream bytes incrementally as the consumer pulls (not all at once)", async () => {
    const lineCount = 10;
    const encoder = new TextEncoder();
    let reads = 0;
    let closed = false;
    const upstream = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads++;
        if (reads <= lineCount) {
          controller.enqueue(encoder.encode(wireChunk({ content: `x${reads}` }) + "\n"));
        } else {
          closed = true;
          controller.close(); // ends without a finish → kit synthesizes "stop"
        }
      },
    });
    const { source } = kit(() => new Response(upstream, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const spec = (await source.listModels())[0]!;
    const chunks = await readAll(await source.stream({ model: spec, request: probeRequest }));

    // 10 content chunks + synthesized terminal.
    expect(chunks).toHaveLength(lineCount + 1);
    expect(chunks[chunks.length - 1]).toMatchObject({ finishReason: "stop", done: true });
    // One upstream read per line was enough to produce each chunk — i.e. the
    // whole response was never buffered into memory at once (a buffering
    // implementation would report reads === 1 here).
    expect(reads).toBe(lineCount + 1);
    expect(closed).toBe(true);
  });
});

describe("createOpenAICompatSource — error mapping", () => {
  it("maps 401 → invalid_api_key", async () => {
    const { source } = kit(() => json({ error: { message: "bad key", code: null } }, 401));
    const spec = (await source.listModels())[0]!;
    await expect(source.stream({ model: spec, request: probeRequest })).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(UpstreamError);
      const up = err as UpstreamError;
      expect(up.status).toBe(401);
      expect(up.code).toBe("invalid_api_key");
      expect(up.message).toBe("bad key");
      return true;
    });
  });

  it("maps 429 → rate_limit_exceeded", async () => {
    const { source } = kit(() => json({ error: { message: "slow down" } }, 429));
    const spec = (await source.listModels())[0]!;
    await expect(source.stream({ model: spec, request: probeRequest })).rejects.toSatisfy((err: unknown) => {
      const up = err as UpstreamError;
      expect(up.status).toBe(429);
      expect(up.code).toBe("rate_limit_exceeded");
      return true;
    });
  });

  it("maps 5xx → upstream_error (even when the provider suggests another code)", async () => {
    const { source } = kit(() => json({ error: { message: "boom", code: "provider_specific" } }, 503));
    const spec = (await source.listModels())[0]!;
    await expect(source.stream({ model: spec, request: probeRequest })).rejects.toSatisfy((err: unknown) => {
      const up = err as UpstreamError;
      expect(up.status).toBe(503);
      expect(up.code).toBe("upstream_error");
      return true;
    });
  });

  it("keeps the provider's own error.code for other statuses", async () => {
    const { source } = kit(() => json({ error: { message: "teapot", code: "i_am_a_teapot" } }, 418));
    const spec = (await source.listModels())[0]!;
    await expect(source.stream({ model: spec, request: probeRequest })).rejects.toSatisfy((err: unknown) => {
      const up = err as UpstreamError;
      expect(up.status).toBe(418);
      expect(up.code).toBe("i_am_a_teapot");
      return true;
    });
  });

  it("handles non-JSON error bodies (e.g. HTML from proxies)", async () => {
    const { source } = kit(() => new Response("<html>oops</html>", { status: 502 }));
    const spec = (await source.listModels())[0]!;
    await expect(source.stream({ model: spec, request: probeRequest })).rejects.toSatisfy((err: unknown) => {
      const up = err as UpstreamError;
      expect(up.status).toBe(502);
      expect(up.code).toBe("upstream_error");
      expect(up.message).toContain("oops");
      return true;
    });
  });

  it("maps a 2xx JSON body with an error object to UpstreamError 502 and the provider code", async () => {
    const { source } = kit(() => json({ error: { message: "soft failure", code: "quota_cooling" } }, 200));
    const spec = (await source.listModels())[0]!;
    await expect(source.stream({ model: spec, request: probeRequest })).rejects.toSatisfy((err: unknown) => {
      const up = err as UpstreamError;
      expect(up.status).toBe(502);
      expect(up.code).toBe("quota_cooling");
      expect(up.message).toBe("soft failure");
      return true;
    });
  });

  it("converts a 2xx non-stream chat.completion JSON body into an equivalent chunk stream", async () => {
    const { source } = kit(() =>
      json({
        id: "c2",
        object: "chat.completion",
        created: 0,
        model: "m1",
        choices: [{ index: 0, message: { role: "assistant", content: "one JSON answer" }, finish_reason: "stop" }],
      }),
    );
    const spec = (await source.listModels())[0]!;
    const chunks = await readAll(await source.stream({ model: spec, request: probeRequest }));
    expect(chunks[0]).toMatchObject({ index: 0, role: "assistant", content: "one JSON answer" });
    expect(chunks[1]).toMatchObject({ index: 1, finishReason: "stop", done: true });
  });
});

describe("createOpenAICompatSource — failures", () => {
  it("network errors surface as UpstreamError 502 network_error", async () => {
    const { source } = kit(() => {
      throw new TypeError("fetch failed");
    });
    const spec = (await source.listModels())[0]!;
    await expect(source.stream({ model: spec, request: probeRequest })).rejects.toSatisfy((err: unknown) => {
      const up = err as UpstreamError;
      expect(up.status).toBe(502);
      expect(up.code).toBe("network_error");
      expect(up.message).toContain("fetch failed");
      return true;
    });
  });

  it("connection timeout surfaces as UpstreamError 504 upstream_timeout", async () => {
    const { source } = kit(() => new Promise<Response>(() => {}), { timeoutMs: 40 });
    const spec = (await source.listModels())[0]!;
    await expect(source.stream({ model: spec, request: probeRequest })).rejects.toSatisfy((err: unknown) => {
      const up = err as UpstreamError;
      expect(up.status).toBe(504);
      expect(up.code).toBe("upstream_timeout");
      return true;
    });
  });

  it("idle stream stall surfaces as a 504 upstream_timeout on the chunk stream", async () => {
    const neverStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(": stall forever\n"));
      },
      pull() {
        // never resolves — a stalled upstream body
      },
    });
    const { source } = kit(() => new Response(neverStream, { status: 200, headers: { "content-type": "text/event-stream" } }), {
      timeoutMs: 50,
    });
    const spec = (await source.listModels())[0]!;
    const stream = await source.stream({ model: spec, request: probeRequest });
    const reader = stream.getReader();
    await expect(reader.read()).rejects.toSatisfy((err: unknown) => {
      const up = err as UpstreamError;
      expect(up.status).toBe(504);
      expect(up.code).toBe("upstream_timeout");
      return true;
    });
  });
});

describe("createOpenAICompatSource — probe", () => {
  it("succeeds, reports latency, sends a minimal stream:false ping with x-airoute-probe", async () => {
    const { source, requests } = kit(() =>
      json({
        id: "c3",
        object: "chat.completion",
        created: 0,
        model: "m1",
        choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
      }),
    );
    const spec = (await source.listModels())[0]!;
    const result = await source.probe(spec);

    expect(result.ok).toBe(true);
    expect(typeof result.latencyMs).toBe("number");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const headers = (requests[0]!.init?.headers ?? {}) as Record<string, string>;
    expect(headers["x-airoute-probe"]).toBe("1"); // probes identifiable in provider logs
    const body = JSON.parse(requests[0]!.init?.body as string) as Record<string, unknown>;
    expect(body["stream"]).toBe(false);
    expect(body["max_tokens"]).toBe(1);
    expect(body["messages"]).toEqual([{ role: "user", content: "ping" }]);
    expect(body["model"]).toBe("m1");
  });

  it("maps 429 to ok:false with error 'rate_limited'", async () => {
    const { source } = kit(() => json({ error: { message: "slow down" } }, 429));
    const spec = (await source.listModels())[0]!;
    const result = await source.probe(spec);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("rate_limited");
    expect(typeof result.latencyMs).toBe("number");
  });

  it("maps network failure to ok:false with error 'network_error'", async () => {
    const { source } = kit(() => {
      throw new TypeError("fetch failed");
    });
    const spec = (await source.listModels())[0]!;
    const result = await source.probe(spec);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("network_error");
  });

  it("maps a never-responding upstream to ok:false with error 'timeout'", async () => {
    const { source } = kit(() => new Promise<Response>(() => {}), { timeoutMs: 40 });
    const spec = (await source.listModels())[0]!;
    const result = await source.probe(spec);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("timeout");
  });

  it("maps other HTTP failures to 'http_<status>'", async () => {
    const { source } = kit(() => json({ error: { message: "bad key" } }, 401));
    const spec = (await source.listModels())[0]!;
    const result = await source.probe(spec);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("http_401");
  });
});

describe("createOpenAICompatSource — complete()", () => {
  it("returns the non-streaming completion (content, finishReason, role)", async () => {
    const { source } = kit(() =>
      json({
        id: "c4",
        object: "chat.completion",
        created: 0,
        model: "m1",
        choices: [{ index: 0, message: { role: "assistant", content: "the answer" }, finish_reason: "stop" }],
      }),
    );
    const spec = (await source.listModels())[0]!;
    const completion = await source.complete(spec, probeRequest);
    expect(completion).toEqual({ content: "the answer", finishReason: "stop", role: "assistant" });
  });

  it("concatenates an upstream SSE body received for a stream:false request", async () => {
    const { source } = kit(() =>
      sse(
        wireChunk({ role: "assistant" }),
        wireChunk({ content: "sse " }),
        wireChunk({ content: "answer" }),
        wireChunk({ finish: "stop" }),
        "data: [DONE]",
        "",
      ),
    );
    const spec = (await source.listModels())[0]!;
    const completion = await source.complete(spec, probeRequest);
    expect(completion.content).toBe("sse answer");
    expect(completion.finishReason).toBe("stop");
  });

  it("reconstructs ToolCall[] from SSE deltas with split arguments (keyed by index)", async () => {
    const { source } = kit(() =>
      sse(
        wireChunk({ role: "assistant" }),
        wireChunk({
          toolCalls: [{ index: 0, id: "call_x", type: "function", function: { name: "get_weather", arguments: "{\"location\":" } }],
        }),
        wireChunk({
          toolCalls: [{ index: 0, function: { arguments: "\"Paris\"}" } }],
        }),
        wireChunk({
          toolCalls: [{ index: 1, id: "call_y", type: "function", function: { name: "get_time", arguments: "{}" } }],
        }),
        wireChunk({ finish: "tool_calls" }),
        "data: [DONE]",
        "",
      ),
    );
    const spec = (await source.listModels())[0]!;
    const completion = await source.complete(spec, probeRequest);
    expect(completion.toolCalls).toEqual([
      { id: "call_x", name: "get_weather", arguments: "{\"location\":\"Paris\"}" },
      { id: "call_y", name: "get_time", arguments: "{}" },
    ]);
    expect(completion.content).toBe("");
    expect(completion.finishReason).toBe("tool_calls");
  });

  it("maps message.tool_calls from a non-stream JSON body into ToolCall[]", async () => {
    const { source } = kit(() =>
      json({
        id: "c9",
        object: "chat.completion",
        created: 0,
        model: "m1",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_z",
                  type: "function",
                  function: { name: "get_weather", arguments: "{\"location\":\"Paris\"}" },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    );
    const spec = (await source.listModels())[0]!;
    const completion = await source.complete(spec, probeRequest);
    expect(completion.toolCalls).toEqual([
      { id: "call_z", name: "get_weather", arguments: "{\"location\":\"Paris\"}" },
    ]);
  });

  it("tolerates malformed message.tool_calls entries and default arguments", async () => {
    const { source } = kit(() =>
      json({
        id: "c10",
        object: "chat.completion",
        created: 0,
        model: "m1",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                "not-an-object",
                { id: "call_ok", function: { name: "ping" } },
                { function: { name: "no-id" } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    );
    const spec = (await source.listModels())[0]!;
    const completion = await source.complete(spec, probeRequest);
    expect(completion.toolCalls).toEqual([{ id: "call_ok", name: "ping", arguments: "{}" }]);
  });

  it("leaves completions without tool calls unchanged (no toolCalls field)", async () => {
    const { source } = kit(() =>
      sse(
        wireChunk({ role: "assistant" }),
        wireChunk({ content: "plain" }),
        wireChunk({ finish: "stop" }),
        "data: [DONE]",
        "",
      ),
    );
    const spec = (await source.listModels())[0]!;
    const completion = await source.complete(spec, probeRequest);
    expect(completion).toEqual({ content: "plain", finishReason: "stop", role: "assistant" });
  });
});

describe("createOpenAICompatSource — extraBody", () => {
  it("merges extraBody fields into the outgoing request body (stream + complete paths)", async () => {
    const { source, requests } = kit(echoResponder, {
      extraBody: { thinking: { type: "disabled" } },
    });
    const spec = (await source.listModels())[0]!;
    await readAll(await source.stream({ model: spec, request: probeRequest }));
    await source.complete(spec, probeRequest);

    const streamBody = JSON.parse(requests[0]!.init?.body as string) as Record<string, unknown>;
    expect(streamBody["thinking"]).toEqual({ type: "disabled" });
    const completeBody = JSON.parse(requests[1]!.init?.body as string) as Record<string, unknown>;
    expect(completeBody["thinking"]).toEqual({ type: "disabled" });
  });

  it("extraBody loses to kit-owned model/messages/stream but wins over mapped IR fields", async () => {
    const { source, requests } = kit(echoResponder, {
      extraBody: { model: "hijacked", messages: [], stream: false, max_tokens: 77 },
    });
    const spec = (await source.listModels())[0]!;
    await readAll(await source.stream({ model: spec, request: { ...probeRequest, max_tokens: 5 } }));

    const body = JSON.parse(requests[0]!.init?.body as string) as Record<string, unknown>;
    // kit-owned fields ignore source-specific overrides…
    expect(body["model"]).toBe("m1");
    expect(body["stream"]).toBe(true); // always-stream-upstream contract
    expect((body["messages"] as unknown[]).length).toBe(1);
    // …while provider knobs beat the fields mapped from the IR request.
    expect(body["max_tokens"]).toBe(77);
  });

  it("absence of extraBody is a no-op (body has exactly the mapped fields)", async () => {
    const { source, requests } = kit(echoResponder);
    const spec = (await source.listModels())[0]!;
    await readAll(await source.stream({ model: spec, request: probeRequest }));
    const body = JSON.parse(requests[0]!.init?.body as string) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["messages", "model", "stream"]);
  });
});

describe("createOpenAICompatSource — reasoning_content stripping", () => {
  it("maps a reasoning-carrying delta to a content-absent chunk (no reasoning text leaks)", async () => {
    const { source } = kit(() =>
      sse(
        wireChunk({ role: "assistant" }),
        data({
          id: "c1",
          object: "chat.completion.chunk",
          created: 0,
          model: "m1",
          choices: [{ index: 7, delta: { reasoning_content: "thinking…", content: "" }, finish_reason: null }],
        }),
        wireChunk({ content: "answer" }),
        wireChunk({ finish: "stop" }),
        "data: [DONE]",
        "",
      ),
    );
    const spec = (await source.listModels())[0]!;
    const chunks = await readAll(await source.stream({ model: spec, request: probeRequest }));

    expect(chunks).toHaveLength(4);
    expect(chunks[0]).toMatchObject({ index: 0, role: "assistant" });
    // the reasoning delta normalized to a plain content-absent chunk
    expect(chunks[1]).toEqual({ index: 1 });
    expect(JSON.stringify(chunks[1])).not.toContain("thinking");
    expect(chunks.flatMap((c) => c.content ?? []).join("")).toBe("answer");
    expect(chunks[2]).toMatchObject({ index: 2, content: "answer" });
    expect(chunks[3]).toMatchObject({ index: 3, finishReason: "stop", done: true });
  });

  it("drops message.reasoning_content in complete() (content '', finishReason passthrough)", async () => {
    const { source } = kit(() =>
      json({
        id: "c5",
        object: "chat.completion",
        created: 0,
        model: "m1",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "", reasoning_content: "chain of thought" },
            finish_reason: "length",
          },
        ],
      }),
    );
    const spec = (await source.listModels())[0]!;
    const completion = await source.complete(spec, probeRequest);
    expect(completion).toEqual({ content: "", finishReason: "length", role: "assistant" });
  });
});

describe("createOpenAICompatSource — option validation", () => {
  it("rejects malformed options with readable ConfigErrors", () => {
    expect(() =>
      createOpenAICompatSource({ id: "kit", baseUrl: "not-a-url", models: [] }),
    ).toThrow(/baseUrl.*http/);
    expect(() =>
      createOpenAICompatSource({ id: "kit", baseUrl: "https://ok", models: "nope" as unknown as OpenAICompatOptions["models"] }),
    ).toThrow(/models/);
    expect(() =>
      createOpenAICompatSource({ id: "kit", baseUrl: "https://ok", models: [{ id: "x", contextWindow: -1 }] }),
    ).toThrow(/contextWindow/);
    expect(() =>
      createOpenAICompatSource({
        id: "kit",
        baseUrl: "https://ok",
        models: [{ id: "x" }],
        headers: { secret: 42 } as unknown as Record<string, string>,
      }),
    ).toThrow(/headers/);
    expect(() =>
      createOpenAICompatSource({ id: "kit", baseUrl: "https://ok", models: [{ id: "x" }], timeoutMs: -5 }),
    ).toThrow(/timeoutMs/);
    expect(() =>
      createOpenAICompatSource({ id: "kit", baseUrl: "https://ok", models: [{ id: "x" }], extraBody: "nope" as unknown as Record<string, unknown> }),
    ).toThrow(/extraBody/);
  });

  it("exposes the validation helpers and defaults for host sources", () => {
    expect(validateBaseUrl(" https://x.y/api/v4/// ", "ctx")).toBe("https://x.y/api/v4");
    expect(validateTimeoutMs(250, "ctx")).toBe(250);
    const defs = validateSourceModelDefs([{ id: "a", aliases: ["x"] }], "ctx");
    expect(defs).toEqual([{ id: "a", aliases: ["x"] }]);
    expect(DEFAULT_OPENAI_COMPAT_TIMEOUT_MS).toBe(60_000);
    expect(new SseTimeoutError("t").name).toBe("SseTimeoutError");
  });
});
