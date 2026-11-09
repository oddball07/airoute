/**
 * Phase 4 alias UX at the HTTP layer: `/v1/models` alias details, alias-aware
 * 404 hints, and actionable 503s when an alias has no usable candidate.
 * Loopback gateway + in-memory health, no external network.
 */
import { type AddressInfo } from "node:net";
import type { ReadableStream } from "node:stream/web";
import {
  createSourceRegistry,
  type IRChunk,
  type ModelSpec,
  type Source,
} from "@airoute/core";
import { startGateway, type GatewayHandle } from "@airoute/gateway";
import { HealthTracker, createInMemoryStore, type MetricsStore } from "@airoute/monitor";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

function spec(id: string): ModelSpec {
  return {
    id,
    sourceId: id.split("/")[0] as string,
    sourceModelId: id.split("/").slice(1).join("/"),
    label: id,
    contextWindow: 128_000,
    caps: { tools: true, vision: false, reasoning: false },
    free: true,
    aliases: [],
  };
}

function okStream(text: string): ReadableStream<IRChunk> {
  return new ReadableStream<IRChunk>({
    start(controller) {
      controller.enqueue({ index: 0, role: "assistant" });
      controller.enqueue({ index: 1, content: text });
      controller.enqueue({ index: 2, finishReason: "stop", done: true });
      controller.close();
    },
  });
}

class MiniSource implements Source {
  constructor(
    readonly id: string,
    readonly specs: ModelSpec[],
  ) {}

  listModels(): Promise<ModelSpec[]> {
    return Promise.resolve(this.specs);
  }

  stream(): Promise<ReadableStream<IRChunk>> {
    return Promise.resolve(okStream("OK"));
  }

  probe(): Promise<{ ok: boolean; at: string }> {
    return Promise.resolve({ ok: true, at: new Date().toISOString() });
  }
}

/* -------------------------------------------------------------------------- */
/* Harnesses                                                                  */
/* -------------------------------------------------------------------------- */

const ALIASES = {
  "free-a": ["a/basic"],
  "free-auto": [],
  "free-legacy": ["gone/model"],
} as const;

let main: GatewayHandle;
let mainUrl: string;
let cooled: GatewayHandle;
let cooledUrl: string;
let empty: GatewayHandle;
let emptyUrl: string;
let store: MetricsStore;

beforeAll(async () => {
  const registry = createSourceRegistry();
  registry.register(new MiniSource("a", [spec("a/basic"), spec("a/large")]));
  registry.register(new MiniSource("b", [spec("b/free")]));
  main = await startGateway({
    registry,
    aliasMap: ALIASES,
    // Identity ranker: enables the empty-bucket catalog fallback the same way
    // `serve` does with the real health-aware ranker.
    ranker: (candidates) => candidates,
    installShutdownHandlers: false,
    port: 0,
  });
  mainUrl = urlOf(main);

  store = createInMemoryStore();
  const health = new HealthTracker({ store });
  health.recordProbe({ sourceId: "a", modelId: "a/basic", ok: false, errorKind: "capacity" });
  health.recordProbe({ sourceId: "a", modelId: "a/basic", ok: false, errorKind: "capacity" });
  const cooledRegistry = createSourceRegistry();
  cooledRegistry.register(new MiniSource("a", [spec("a/basic")]));
  cooled = await startGateway({
    registry: cooledRegistry,
    aliasMap: { "free-a": ["a/basic"] },
    health,
    installShutdownHandlers: false,
    port: 0,
  });
  cooledUrl = urlOf(cooled);

  empty = await startGateway({
    registry: createSourceRegistry(),
    aliasMap: { "free-best": [] },
    ranker: (candidates) => candidates,
    installShutdownHandlers: false,
    port: 0,
  });
  emptyUrl = urlOf(empty);
});

afterAll(async () => {
  await Promise.all([main?.stop(), cooled?.stop(), empty?.stop()]);
  store?.close();
});

function urlOf(handle: GatewayHandle): string {
  const address = handle.server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function postChat(baseUrl: string, model: string): Promise<Response> {
  return fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
  });
}

/* -------------------------------------------------------------------------- */
/* /v1/models                                                                 */
/* -------------------------------------------------------------------------- */

describe("GET /v1/models alias details", () => {
  it("describes every configured alias and its resolved candidates", async () => {
    const response = await fetch(`${mainUrl}/v1/models`);
    const body = (await response.json()) as {
      aliases: string[];
      alias_details: Record<
        string,
        { mode: string; fallback: boolean; candidates: string[] }
      >;
    };
    expect(body.aliases).toEqual(["free-a", "free-auto", "free-legacy"]);
    expect(body.alias_details["free-a"]).toEqual({
      mode: "explicit",
      fallback: false,
      candidates: ["a/basic"],
    });
    expect(body.alias_details["free-auto"]?.mode).toBe("auto");
    expect(body.alias_details["free-auto"]?.candidates).toEqual([
      "a/basic",
      "a/large",
      "b/free",
    ]);
    // Non-empty bucket whose ids vanished: honest "auto (fallback)".
    expect(body.alias_details["free-legacy"]).toMatchObject({ mode: "auto", fallback: true });
  });
});

/* -------------------------------------------------------------------------- */
/* Unknown model / alias errors                                               */
/* -------------------------------------------------------------------------- */

describe("alias-aware routing errors", () => {
  it("includes alias names in 404 hints and machine-readable details", async () => {
    const response = await postChat(mainUrl, "free-aa");
    expect(response.status).toBe(404);
    const body = (await response.json()) as {
      error: { message: string; code: string; details?: Record<string, unknown> };
    };
    expect(body.error.code).toBe("model_not_found");
    expect(body.error.message).toContain("did you mean");
    expect(body.error.message).toContain("aliases: free-a");
    expect(body.error.details?.["aliases"]).toEqual(["free-a", "free-auto", "free-legacy"]);
    expect(body.error.details?.["available"]).toContain("a/basic");
  });

  it("explains that a configured alias has no candidates (503, not 404)", async () => {
    const response = await postChat(emptyUrl, "free-best");
    expect(response.status).toBe(503);
    const body = (await response.json()) as {
      error: { message: string; code: string; details?: Record<string, unknown> };
    };
    expect(body.error.code).toBe("alias_unavailable");
    expect(body.error.message).toContain("no available candidates");
    expect(body.error.details?.["declared"]).toEqual([]);
  });

  it("lists per-candidate health when every candidate is cooling", async () => {
    const response = await postChat(cooledUrl, "free-a");
    expect(response.status).toBe(503);
    const body = (await response.json()) as {
      error: {
        message: string;
        code: string;
        details?: { candidates?: Array<{ model: string; state: string; retry_in_ms?: number }> };
      };
    };
    expect(body.error.code).toBe("all_candidates_unavailable");
    expect(body.error.message).toContain("no candidate");
    expect(body.error.message).toContain("a/basic: cooling");
    const candidate = body.error.details?.candidates?.[0];
    expect(candidate?.model).toBe("a/basic");
    expect(candidate?.state).toBe("cooling");
    expect(candidate?.retry_in_ms ?? 0).toBeGreaterThan(0);
  });
});
