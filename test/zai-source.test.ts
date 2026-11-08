/**
 * ZAI source plugin tests. Offline except for the loopback mock provider
 * (`startMockProvider` from @airoute/mock-provider — an OpenAI-compatible
 * server on 127.0.0.1); injected `fetch` covers the remaining seams. No real
 * network is ever touched.
 */
import { ConfigError, UpstreamError, type IRChunk, type IRRequest } from "@airoute/core";
import { startMockProvider, type StartedMockProvider } from "@airoute/mock-provider";
import {
  createZaiSource,
  createZaiSourceFactory,
  DEFAULT_ZAI_BASE_URL,
  DEFAULT_ZAI_MODELS,
  DEFAULT_ZAI_THINKING,
  ZAI_ENV_KEY,
  type ZaiSourceOptions,
} from "@airoute/zai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

let provider: StartedMockProvider | undefined;

beforeAll(async () => {
  provider = await startMockProvider(); // default scenario: echo
});

afterAll(async () => {
  await provider?.close();
  provider = undefined;
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

function kitFetch(responder: () => Response | Promise<Response>): typeof fetch {
  // The zai source hands this straight to the kit; URL/body assertions for
  // request shape live in the openai-compat kit tests.
  return (async (_input: RequestInfo | URL, _init?: RequestInit) => responder()) as typeof fetch;
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe("createZaiSource — construction & listModels", () => {
  it("defaults: id 'zai', the Z.AI base URL, flash-tier default models", async () => {
    const source = createZaiSource({ apiKey: "test", fetch: kitFetch(() => new Response("data: [DONE]\n", { status: 200, headers: { "content-type": "text/event-stream" } })) });
    expect(source.id).toBe("zai");
    expect(DEFAULT_ZAI_BASE_URL).toBe("https://api.z.ai/api/paas/v4");

    const specs = await source.listModels();
    const ids = specs.map((spec) => spec.id);
    expect(ids).toEqual([
      "zai/glm-4.5-flash",
      "zai/glm-4.7-flash",
    ]);
    for (const spec of specs) {
      expect(spec.sourceId).toBe("zai");
      expect(spec.sourceModelId).toBe(spec.id.slice("zai/".length));
      expect(spec.free).toBe(true); // Phase 1: free-only gating for every model
      expect(spec.contextWindow).toBe(128_000);
      expect(spec.caps).toEqual({ tools: true, vision: false, reasoning: false });
      expect(spec.aliases).toEqual([]);
      expect(spec.meta).toMatchObject({ contextWindow: 128_000, raw: { id: spec.sourceModelId } });
    }
  });

  it("DEFAULT_ZAI_MODELS is the source of truth for the default list (verified 2026-11-08)", () => {
    expect(DEFAULT_ZAI_MODELS.map((def) => def.id)).toEqual([
      "glm-4.5-flash",
      "glm-4.7-flash",
    ]);
  });

  it("defaults apiKey to process.env[ZAI_API_KEY] (and omits auth when unset)", async () => {
    const previous = process.env[ZAI_ENV_KEY];
    delete process.env[ZAI_ENV_KEY];
    try {
      let sawAuth: string | undefined;
      const source = createZaiSource({
        fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
          sawAuth = (init?.headers as Record<string, string>)["authorization"];
          return new Response(
            "data: {\"choices\":[]}\ndata: [DONE]\n",
            { status: 200, headers: { "content-type": "text/event-stream" } },
          );
        }) as typeof fetch,
      });
      const spec = (await source.listModels())[0]!;
      await readAll(await source.stream({ model: spec, request: { model: spec.id, messages: [{ role: "user", content: "x" }] } }));
      expect(sawAuth).toBeUndefined();

      process.env[ZAI_ENV_KEY] = "env-key-value";
      const withEnv = createZaiSource({
        fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
          sawAuth = (init?.headers as Record<string, string>)["authorization"];
          return new Response(
            "data: {\"choices\":[]}\ndata: [DONE]\n",
            { status: 200, headers: { "content-type": "text/event-stream" } },
          );
        }) as typeof fetch,
      });
      {
        const specs = await withEnv.listModels();
        const first = specs[0]!;
        await readAll(await withEnv.stream({ model: first, request: { model: first.id, messages: [{ role: "user", content: "x" }] } }));
      }
      expect(sawAuth).toBe("Bearer env-key-value");
    } finally {
      if (previous === undefined) delete process.env[ZAI_ENV_KEY];
      else process.env[ZAI_ENV_KEY] = previous;
    }
  });

  it("rejects malformed options with readable ConfigErrors", () => {
    const bad = (options: ZaiSourceOptions): Error | undefined => {
      try {
        createZaiSource(options);
        return undefined;
      } catch (err) {
        return err instanceof Error ? err : undefined;
      }
    };
    expect(bad({ baseUrl: "nope" })?.message).toContain("baseUrl");
    expect(bad({ timeoutMs: 0 })?.message).toContain("timeoutMs");
    expect(bad({ models: [{ id: "" }] })?.message).toContain("models[0].id");
    expect(bad({ thinking: "fast" as unknown as ZaiSourceOptions["thinking"] })?.message).toContain('"thinking"');
  });
});

describe("createZaiSource — thinking control", () => {
  const capturingKitFetch = (bodies: Array<Record<string, unknown> | undefined>): typeof fetch =>
    (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(init?.body as string) as Record<string, unknown>);
      return new Response("data: [DONE]\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

  it("defaults thinking to 'disabled': outgoing requests carry thinking {type:'disabled'}", async () => {
    const bodies: Array<Record<string, unknown> | undefined> = [];
    const source = createZaiSource({ apiKey: "test", fetch: capturingKitFetch(bodies) });
    const spec = (await source.listModels())[0]!;
    await readAll(
      await source.stream({
        model: spec,
        request: { model: spec.id, messages: [{ role: "user", content: "x" }] },
      }),
    );
    // Verified live (2026-11-08): thinking-off makes glm-4.5-flash answer in
    // `content` instead of exhausting max_tokens on reasoning_content.
    expect(bodies[0]?.["thinking"]).toEqual({ type: "disabled" });
  });

  it("thinking 'enabled' omits the extra body field entirely (ZAI decides)", async () => {
    const bodies: Array<Record<string, unknown> | undefined> = [];
    const source = createZaiSource({ apiKey: "test", thinking: "enabled", fetch: capturingKitFetch(bodies) });
    const spec = (await source.listModels())[0]!;
    await readAll(
      await source.stream({
        model: spec,
        request: { model: spec.id, messages: [{ role: "user", content: "x" }] },
      }),
    );
    expect(bodies[0]?.["thinking"]).toBeUndefined();
  });
});

describe("createZaiSourceFactory — config entry handling", () => {
  it("builds the default source from a bare enabled entry", async () => {
    const source = createZaiSourceFactory({ type: "zai", enabled: true });
    expect(source.id).toBe("zai");
    const ids = (await source.listModels()).map((spec) => spec.id);
    expect(ids).toContain("zai/glm-4.5-flash");
  });

  it("reads entry options: baseUrl override, models override, timeoutMs", async () => {
    const source = createZaiSourceFactory({
      type: "zai",
      enabled: true,
      baseUrl: `${mockSourceUrl()}`,
      models: [{ id: "custom-glm", label: "Custom GLM", contextWindow: 4_096, caps: { vision: true }, aliases: ["cg"] }],
      timeoutMs: 1_500,
    });
    expect(source.id).toBe("zai");
    const specs = await source.listModels();
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({
      id: "zai/custom-glm",
      sourceModelId: "custom-glm",
      label: "Custom GLM",
      contextWindow: 4_096,
      aliases: ["cg"],
    });
    expect(specs[0]!.caps).toEqual({ tools: true, vision: true, reasoning: false });
  });

  it("throws ConfigError naming the offending entry option", () => {
    const expectConfigError = (entry: Record<string, unknown>, fragment: string): void => {
      try {
        createZaiSourceFactory({ type: "zai", enabled: true, ...entry });
        expect.fail(`expected ConfigError for ${JSON.stringify(entry)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        const message = err instanceof Error ? err.message : String(err);
        expect((err as ConfigError).name).toBe("ConfigError");
        expect(message).toContain("source 'zai'");
        expect(message).toContain(fragment);
      }
    };
    expectConfigError({ baseUrl: 123 }, '"baseUrl"');
    expectConfigError({ baseUrl: "ftp://x" }, "http://");
    expectConfigError({ models: "no" }, '"models"');
    expectConfigError({ models: [{ id: "x", contextWindow: "big" }] }, "models[0].contextWindow");
    expectConfigError({ models: [{ id: "x", caps: { tools: "yes" } }] }, "models[0].caps.tools");
    expectConfigError({ models: [{ id: "x", aliases: [7] }] }, "models[0].aliases");
    expectConfigError({ timeoutMs: "fast" }, '"timeoutMs"');
    expectConfigError({ thinking: "fast" }, '"thinking"');
  });

  it("accepts both thinking values from an entry; bare entries default to 'disabled'", () => {
    expect(DEFAULT_ZAI_THINKING).toBe("disabled");
    expect(createZaiSourceFactory({ type: "zai", enabled: true, thinking: "disabled" }).id).toBe("zai");
    expect(createZaiSourceFactory({ type: "zai", enabled: true, thinking: "enabled" }).id).toBe("zai");
  });
});

describe("createZaiSource — against the mock provider (real fetch, loopback)", () => {
  const chatRequest = (modelId: string): IRRequest => ({
    model: modelId,
    messages: [{ role: "user", content: "zai ping" }],
  });

  it("echoes an IR chunk stream end-to-end: role first, ordered content, terminal stop", async () => {
    const source = createZaiSource({ baseUrl: mockSourceUrl(), apiKey: "test" });
    const spec = (await source.listModels()).find((s) => s.id === "zai/glm-4.5-flash")!;
    expect(spec).toBeDefined();

    const stream = await source.stream({ model: spec, request: chatRequest(spec.id) });
    const chunks = await readAll(stream);

    expect(chunks[0]!.role).toBe("assistant");
    const text = chunks.flatMap((c) => c.content ?? []).join("");
    expect(text).toBe("ECHO: zai ping");
    const last = chunks[chunks.length - 1]!;
    expect(last.finishReason).toBe("stop");
    expect(last.done).toBe(true);
    chunks.forEach((chunk, i) => expect(chunk.index).toBe(i));
  });

  it("probes successfully against the mock provider", async () => {
    const source = createZaiSource({ baseUrl: mockSourceUrl(), apiKey: "test" });
    const spec = (await source.listModels())[0]!;
    const result = await source.probe(spec);
    expect(result.ok).toBe(true);
    expect(typeof result.latencyMs).toBe("number");
    expect(result.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("maps the mock's bad-key 401 through UpstreamError", async () => {
    const badKey = await startMockProvider({ scenario: "bad-key" });
    try {
      const source = createZaiSource({ baseUrl: `${badKey.url}/v1`, apiKey: "wrong" });
      const spec = (await source.listModels())[0]!;

      await expect(source.stream({ model: spec, request: chatRequest(spec.id) })).rejects.toSatisfy(
        (err: unknown) => {
          expect(err).toBeInstanceOf(UpstreamError);
          const up = err as UpstreamError;
          expect(up.status).toBe(401);
          expect(up.code).toBe("invalid_api_key");
          return true;
        },
      );

      const probe = await source.probe(spec);
      expect(probe.ok).toBe(false);
      expect(probe.error).toBe("http_401");
    } finally {
      await badKey.close();
    }
  });
});
