/**
 * OpenRouter source plugin tests. Offline except for the loopback mock
 * provider (`startMockProvider` from @airoute/mock-provider — an
 * OpenAI-compatible server on 127.0.0.1); injected `fetch` covers the
 * catalog-mapping seams. No real network is ever touched.
 *
 * Coverage:
 *   1. Catalog mapping (synthetic fetch): free filter, entry mapping,
 *      malformed-entry warn-skip, alphabetical ordering, header shape.
 *   2. allow / disallow / maxModels behavior.
 *   3. Catalog failure mapping: non-2xx, fetch failure, timeout.
 *   4. Static-models override path end-to-end against the mock provider:
 *      listModels, stream, probe, and 429 → UpstreamError.
 */
import { UpstreamError, createLogger, type IRChunk, type IRRequest, type Logger } from "@airoute/core";
import { startMockProvider, type StartedMockProvider } from "@airoute/mock-provider";
import {
  createOpenRouterSource,
  createOpenRouterSourceFactory,
  DEFAULT_OPENROUTER_BASE_URL,
  DEFAULT_OPENROUTER_CATALOG_TIMEOUT_MS,
  DEFAULT_OPENROUTER_MAX_MODELS,
  DEFAULT_OPENROUTER_TITLE,
  OPENROUTER_ENV_KEY,
} from "@airoute/openrouter";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

let provider: StartedMockProvider | undefined;
let rateLimited: StartedMockProvider | undefined;

beforeAll(async () => {
  provider = await startMockProvider(); // echo scenario
  rateLimited = await startMockProvider({ scenario: "429-storm" });
});

afterAll(async () => {
  await provider?.close();
  provider = undefined;
  await rateLimited?.close();
  rateLimited = undefined;
});

function mockSourceUrl(): string {
  return `${provider!.url}/v1`; // mock chat endpoint = /v1/chat/completions
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

function capturingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const fake = {
    write: (chunk: string): boolean => {
      lines.push(chunk);
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  return { logger: createLogger({ scope: "test", err: fake, out: fake }), lines };
}

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
}

/** Synthetic fetch returning a canned body, capturing every request shape. */
function catalogFetch(
  responder: (call: number) => { status?: number; body: string } | Promise<{ status?: number; body: string }>,
): { fetch: typeof fetch; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  let count = 0;
  const theFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    count += 1;
    calls.push({
      url: String(input),
      method: (init?.method ?? "GET").toUpperCase(),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    });
    const result = await responder(count);
    return new Response(result.body, {
      status: result.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetch: theFetch, calls };
}

/** Canned `/models` body covering every mapping case from the plan. */
function cannedCatalogBody(): string {
  return JSON.stringify({
    data: [
      // paid with pricing > 0 → dropped
      {
        id: "openai/gpt-4o-mini",
        name: "OpenAI: GPT-4o-mini",
        context_length: 128000,
        pricing: { prompt: "0.00000015", completion: "0.0000006" },
        supported_parameters: ["tools"],
      },
      // malformed (no usable id) → warn + skip
      { name: "no id entry" },
      // genuinely free (":free" suffix, explicit zero pricing), both context sources
      {
        id: "deepseek/deepseek-chat-v3.1:free",
        name: "DeepSeek: DeepSeek V3.1 (free)",
        context_length: 163840,
        top_provider: { context_length: 65536 },
        pricing: { prompt: "0", completion: "0" },
        architecture: { input_modalities: ["text"] },
        supported_parameters: ["tools", "reasoning"],
      },
      // genuinely free (":free" suffix, NO pricing field at all), top_provider fallback
      {
        id: "qwen/qwen3-coder:free",
        name: "Qwen: Qwen3 Coder (free)",
        pricing: {} as Record<string, unknown>,
        top_provider: { context_length: 40960 },
        architecture: { input_modalities: ["text", "image"] },
        supported_parameters: ["tools", "include_reasoning"], // second reasoning parameter name
      },
      // ":free" id with pricing "0" string — kept via the suffix rule
      {
        id: "microsoft/mai-ds-r1:free",
        name: "Microsoft: MAI DS R1 (free)",
        pricing: { prompt: "0", completion: "0" },
        supported_parameters: ["tools"],
      },
    ],
  });
}

function catalogSource(overrides: Record<string, unknown> = {}): ReturnType<typeof createOpenRouterSource> {
  const options = {
    apiKey: "test-key",
    fetch: catalogFetch(() => ({ body: cannedCatalogBody() })).fetch,
    ...overrides,
  };
  return createOpenRouterSource(options as Parameters<typeof createOpenRouterSource>[0]);
}

/* -------------------------------------------------------------------------- */
/* 1. Catalog mapping                                                         */
/* -------------------------------------------------------------------------- */

describe("openrouter catalog mapping (synthetic fetch)", () => {
  it("maps, filters to free only, sorts alphabetically, and warns on malformed entries", async () => {
    const { logger, lines } = capturingLogger();
    const source = catalogSource({ logger });
    const specs = await source.listModels();

    expect(specs.map((spec) => spec.id)).toEqual([
      "openrouter/deepseek/deepseek-chat-v3.1:free",
      "openrouter/microsoft/mai-ds-r1:free",
      "openrouter/qwen/qwen3-coder:free",
    ]);
    for (const spec of specs) {
      expect(spec.free).toBe(true); // Phase 1: free-only
      expect(spec.sourceId).toBe("openrouter");
      expect(spec.sourceModelId).toBe(spec.id.slice("openrouter/".length));
      expect(spec.aliases).toEqual([]);
    }

    const deepseek = specs[0]!;
    expect(deepseek.label).toBe("DeepSeek: DeepSeek V3.1 (free)");
    expect(deepseek.contextWindow).toBe(163840); // context_length wins over top_provider
    expect(deepseek.caps).toEqual({ tools: true, vision: false, reasoning: true });
    expect(deepseek.meta).toMatchObject({ contextWindow: 163840, raw: { id: deepseek.sourceModelId } });

    const qwen = specs[2]!;
    expect(qwen.label).toBe("Qwen: Qwen3 Coder (free)");
    expect(qwen.contextWindow).toBe(40960); // top_provider.context_length fallback
    expect(qwen.caps).toEqual({ tools: true, vision: true, reasoning: true }); // include_reasoning variant

    const mai = specs[1]!;
    expect(mai.caps).toEqual({ tools: true, vision: false, reasoning: false });

    const warns = lines.filter((line) => line.includes("skipped an entry without a usable 'id'"));
    expect(warns).toHaveLength(1);
    // Paid entries are dropped silently, not warned about.
    expect(lines.some((line) => line.includes("gpt-4o-mini"))).toBe(false);
  });

  it("GETs `${baseUrl}/models` with the attribution headers the plan requires", async () => {
    const { fetch, calls } = catalogFetch(() => ({ body: cannedCatalogBody() }));
    const source = createOpenRouterSource({ apiKey: "or-key", fetch, referer: "https://example.com" });
    await source.listModels();

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe("GET");
    expect(call.url).toBe(`${DEFAULT_OPENROUTER_BASE_URL}/models`);
    expect(call.headers["authorization"]).toBe("Bearer or-key");
    expect(call.headers["x-title"]).toBe(DEFAULT_OPENROUTER_TITLE);
    expect(call.headers["http-referer"]).toBe("https://example.com");
    expect(call.headers["accept"]).toBe("application/json");
  });

  it("omits the Authorization header when no key is set (catalog is public)", async () => {
    const { fetch, calls } = catalogFetch(() => ({ body: cannedCatalogBody() }));
    const source = createOpenRouterSource({ fetch, referer: "" });
    await source.listModels();
    const call = calls[0]!;
    expect(call.headers["authorization"]).toBeUndefined();
    expect(call.headers["http-referer"]).toBeUndefined();
    expect(call.headers["x-title"]).toBe(DEFAULT_OPENROUTER_TITLE);
  });

  it("exposes the documented defaults", () => {
    expect(DEFAULT_OPENROUTER_BASE_URL).toBe("https://openrouter.ai/api/v1");
    expect(DEFAULT_OPENROUTER_CATALOG_TIMEOUT_MS).toBe(10_000);
    expect(DEFAULT_OPENROUTER_MAX_MODELS).toBe(500);
    expect(DEFAULT_OPENROUTER_TITLE).toBe("AIRoute");
  });
});

/* -------------------------------------------------------------------------- */
/* 2. allow / disallow / maxModels                                            */
/* -------------------------------------------------------------------------- */

describe("openrouter allow/disallow/maxModels", () => {
  it("allow keeps only matching entries (substring and regex-source patterns)", async () => {
    const byString = catalogSource({ allow: ["deepseek"] });
    expect((await byString.listModels()).map((s) => s.id)).toEqual([
      "openrouter/deepseek/deepseek-chat-v3.1:free",
    ]);

    const byRegex = catalogSource({ allow: [".*qwen.*:free$", "^no-match"] });
    expect((await byRegex.listModels()).map((s) => s.id)).toEqual(["openrouter/qwen/qwen3-coder:free"]);

    // Invalid regex falls back to the substring reading only.
    const byInvalidRegex = catalogSource({ allow: ["qwen(?:free"] });
    expect((await byInvalidRegex.listModels()).map((s) => s.id)).toEqual([]);
    const stillSubstring = catalogSource({ allow: ["qwen"] });
    expect((await stillSubstring.listModels()).map((s) => s.id)).toEqual(["openrouter/qwen/qwen3-coder:free"]);
  });

  it("disallow drops matching entries after allow", async () => {
    const both = catalogSource({ allow: [":free"], disallow: ["qwen", "mai"] });
    expect((await both.listModels()).map((s) => s.id)).toEqual([
      "openrouter/deepseek/deepseek-chat-v3.1:free",
    ]);

    const onlyDisallow = catalogSource({ disallow: ["deepseek"] });
    expect((await onlyDisallow.listModels()).map((s) => s.id)).toEqual([
      "openrouter/microsoft/mai-ds-r1:free",
      "openrouter/qwen/qwen3-coder:free",
    ]);
  });

  it("maxModels caps the alphabetically-sorted kept list; 0 means uncapped", async () => {
    const capped = catalogSource({ maxModels: 1 });
    expect((await capped.listModels()).map((s) => s.id)).toEqual([
      "openrouter/deepseek/deepseek-chat-v3.1:free",
    ]);

    const uncapped = catalogSource({ maxModels: 0 });
    expect(await uncapped.listModels()).toHaveLength(3);
  });
});

/* -------------------------------------------------------------------------- */
/* 3. Catalog failure mapping                                                 */
/* -------------------------------------------------------------------------- */

describe("openrouter catalog failures", () => {
  it("maps a non-2xx catalog response onto UpstreamError http_<status>", async () => {
    const source = catalogSource({ fetch: catalogFetch(() => ({ status: 500, body: "boom" })).fetch });
    await expect(source.listModels()).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(UpstreamError);
      const up = err as UpstreamError;
      expect(up.status).toBe(500);
      expect(up.code).toBe("http_500");
      return true;
    });
  });

  it("maps a fetch-level failure onto UpstreamError network_error", async () => {
    const source = catalogSource({
      fetch: (async () => {
        throw new TypeError("connect ECONNREFUSED");
      }) as typeof fetch,
    });
    await expect(source.listModels()).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(UpstreamError);
      const up = err as UpstreamError;
      expect(up.status).toBe(502);
      expect(up.code).toBe("network_error");
      expect(up.message).toContain("ECONNREFUSED");
      return true;
    });
  });

  it("maps an unparseable 2xx body onto UpstreamError upstream_error", async () => {
    const source = catalogSource({ fetch: catalogFetch(() => ({ body: "<html>nope</html>" })).fetch });
    await expect(source.listModels()).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(UpstreamError);
      const up = err as UpstreamError;
      expect(up.status).toBe(502);
      expect(up.code).toBe("upstream_error");
      return true;
    });
  });

  it("times out a wedged catalog response after catalogTimeoutMs", async () => {
    const source = catalogSource({
      catalogTimeoutMs: 50,
      fetch: (async () => new Promise<Response>(() => {})) as unknown as typeof fetch, // never settles
    });
    await expect(source.listModels()).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(UpstreamError);
      const up = err as UpstreamError;
      expect(up.status).toBe(504);
      expect(up.code).toBe("network_error");
      expect(up.message).toContain("timed out");
      return true;
    });
  });
});

/* -------------------------------------------------------------------------- */
/* 4. Static-models override path against the mock provider                    */
/* -------------------------------------------------------------------------- */

describe("openrouter static-models override (mock provider, loopback)", () => {
  const chatRequest = (modelId: string): IRRequest => ({
    model: modelId,
    messages: [{ role: "user", content: "openrouter ping" }],
  });

  it("end-to-end: listModels → stream → probe against the mock provider", async () => {
    const source = createOpenRouterSource({
      baseUrl: mockSourceUrl(),
      apiKey: "test",
      models: [{ id: "deepseek/deepseek-chat-v3.1:free", label: "DeepSeek V3.1 (free)", contextWindow: 163840 }],
    });
    expect(source.id).toBe("openrouter");

    const specs = await source.listModels();
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({
      id: "openrouter/deepseek/deepseek-chat-v3.1:free",
      sourceModelId: "deepseek/deepseek-chat-v3.1:free",
      label: "DeepSeek V3.1 (free)",
      contextWindow: 163840,
      free: true,
    });

    const spec = specs[0]!;
    const chunks = await readAll(await source.stream({ model: spec, request: chatRequest(spec.id) }));
    expect(chunks[0]!.role).toBe("assistant");
    const text = chunks.flatMap((chunk) => chunk.content ?? []).join("");
    expect(text).toBe("ECHO: openrouter ping");
    const last = chunks[chunks.length - 1]!;
    expect(last.finishReason).toBe("stop");
    expect(last.done).toBe(true);
    chunks.forEach((chunk, i) => expect(chunk.index).toBe(i));

    const probe = await source.probe(spec);
    expect(probe.ok).toBe(true);
    expect(typeof probe.latencyMs).toBe("number");
    expect(probe.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const completion = await source.complete(spec, chatRequest(spec.id));
    expect(completion.content).toBe("ECHO: openrouter ping");
    expect(completion.finishReason).toBe("stop");
  });

  it("429 scenario: stream rejects with UpstreamError 429 / rate_limit_exceeded and probe reports rate_limited", async () => {
    const source = createOpenRouterSource({
      baseUrl: `${rateLimited!.url}/v1`,
      apiKey: "test",
      models: [{ id: "deepseek/deepseek-chat-v3.1:free" }],
    });
    const spec = (await source.listModels())[0]!;

    await expect(source.stream({ model: spec, request: chatRequest(spec.id) })).rejects.toSatisfy(
      (err: unknown) => {
        expect(err).toBeInstanceOf(UpstreamError);
        const up = err as UpstreamError;
        expect(up.status).toBe(429);
        expect(up.code).toBe("rate_limit_exceeded");
        return true;
      },
    );

    const probe = await source.probe(spec);
    expect(probe.ok).toBe(false);
    expect(probe.error).toBe("rate_limited");
  });

  it("defaults the key to process.env[OPENROUTER_API_KEY] and never bakes it into a spec", async () => {
    const previous = process.env[OPENROUTER_ENV_KEY];
    delete process.env[OPENROUTER_ENV_KEY];
    try {
      const { fetch, calls } = catalogFetch(() => ({ body: cannedCatalogBody() }));
      const withoutEnv = createOpenRouterSource({ fetch });
      await withoutEnv.listModels();
      expect(calls[0]!.headers["authorization"]).toBeUndefined(); // catalog is public; no key → no header

      process.env[OPENROUTER_ENV_KEY] = "env-key-value";
      const { fetch: fetch2, calls: calls2 } = catalogFetch(() => ({ body: cannedCatalogBody() }));
      const withEnv = createOpenRouterSource({ fetch: fetch2 });
      await withEnv.listModels();
      expect(calls2[0]!.headers["authorization"]).toBe("Bearer env-key-value");
    } finally {
      if (previous === undefined) delete process.env[OPENROUTER_ENV_KEY];
      else process.env[OPENROUTER_ENV_KEY] = previous;
    }
    // The key is never baked into a spec, whatever its source.
    const specs = await (createOpenRouterSource({ apiKey: "secret", models: [{ id: "x:free" }] })).listModels();
    expect(JSON.stringify(specs)).not.toContain("secret");
  });
});

/* -------------------------------------------------------------------------- */
/* 5. Factory: config entry handling                                          */
/* -------------------------------------------------------------------------- */

describe("createOpenRouterSourceFactory — config entry handling", () => {
  it("builds a static-override source from the entry options", async () => {
    const source = createOpenRouterSourceFactory({
      type: "openrouter",
      enabled: true,
      baseUrl: mockSourceUrl(),
      models: [{ id: "deepseek/deepseek-chat-v3.1:free", label: "DeepSeek V3.1 (free)", contextWindow: 163840 }],
      maxModels: 10,
      allow: ["deepseek"],
      disallow: ["paid"],
      catalogTimeoutMs: 5_000,
      title: "MyAiroute",
      referer: "https://example.com",
      timeoutMs: 1_500,
    });
    expect(source.id).toBe("openrouter");
    const ids = (await source.listModels()).map((spec) => spec.id);
    expect(ids).toEqual(["openrouter/deepseek/deepseek-chat-v3.1:free"]);
  });

  it("throws ConfigError naming the offending entry option", () => {
    const expectConfigError = (entry: Record<string, unknown>, fragment: string): void => {
      try {
        createOpenRouterSourceFactory({ type: "openrouter", enabled: true, ...entry });
        expect.fail(`expected ConfigError for ${JSON.stringify(entry)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        const message = err instanceof Error ? err.message : String(err);
        expect(message).toContain("source 'openrouter'");
        expect(message).toContain(fragment);
      }
    };
    expectConfigError({ baseUrl: 123 }, '"baseUrl"');
    expectConfigError({ baseUrl: "ftp://x" }, "http://");
    expectConfigError({ models: "no" }, '"models"');
    expectConfigError({ models: [{ id: "x", contextWindow: "big" }] }, "models[0].contextWindow");
    expectConfigError({ maxModels: -1 }, '"maxModels"');
    expectConfigError({ maxModels: "many" }, '"maxModels"');
    expectConfigError({ allow: "deepseek" }, '"allow"');
    expectConfigError({ allow: [7] }, '"allow"');
    expectConfigError({ disallow: 5 }, '"disallow"');
    expectConfigError({ catalogTimeoutMs: 0 }, '"catalogTimeoutMs"');
    expectConfigError({ title: 9 }, '"title"');
    expectConfigError({ referer: [] }, '"referer"');
    expectConfigError({ timeoutMs: "slow" }, '"timeoutMs"');
  });
});
