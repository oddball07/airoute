/**
 * Gateway × monitor wiring tests: ranked aliases, health-aware failover and
 * passive request recording. Loopback HTTP + in-memory SQLite, no external
 * network.
 */
import { type AddressInfo } from "node:net";
import type { ReadableStream } from "node:stream/web";
import {
  UpstreamError,
  createSourceRegistry,
  type IRChunk,
  type ModelSpec,
  type Source,
} from "@airoute/core";
import { startGateway, type GatewayHandle, type GatewayOptions } from "@airoute/gateway";
import { HealthTracker, createInMemoryStore, type MetricsStore } from "@airoute/monitor";
import { afterEach, describe, expect, it } from "vitest";
import { createTestLogger } from "./helpers/test-logger.js";

const cleanups: Array<() => void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function spec(sourceId: string, name: string, contextWindow = 128_000): ModelSpec {
  return {
    id: `${sourceId}/${name}`,
    sourceId,
    sourceModelId: name,
    label: name,
    contextWindow,
    caps: { tools: false, vision: false, reasoning: false },
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

class TestSource implements Source {
  readonly id: string;
  readonly specs: ModelSpec[];
  calls = 0;
  readonly #behavior: (model: ModelSpec) => Promise<ReadableStream<IRChunk>>;

  constructor(id: string, specs: ModelSpec[], behavior: (model: ModelSpec) => Promise<ReadableStream<IRChunk>>) {
    this.id = id;
    this.specs = specs;
    this.#behavior = behavior;
  }

  listModels(): Promise<ModelSpec[]> {
    return Promise.resolve(this.specs);
  }

  stream(req: { model: ModelSpec }): Promise<ReadableStream<IRChunk>> {
    this.calls += 1;
    return this.#behavior(req.model);
  }

  probe(): Promise<{ ok: boolean; at: string }> {
    return Promise.resolve({ ok: true, at: new Date().toISOString() });
  }
}

function failingSource(id: string, message: string, status: number): TestSource {
  return new TestSource(id, [spec(id, "a")], async () => {
    throw new UpstreamError(message, { status });
  });
}

function okSource(id: string, text: string, contextWindow = 128_000): TestSource {
  return new TestSource(id, [spec(id, "a", contextWindow)], async () => okStream(text));
}

interface Harness {
  url: string;
  store: MetricsStore;
  health: HealthTracker;
  loggerWarns: string[];
}

async function harness(options: {
  sources: Source[];
  aliasMap?: Record<string, string[]>;
  health?: boolean;
  ranker?: GatewayOptions["ranker"];
}): Promise<Harness> {
  const registry = createSourceRegistry();
  registry.registerAll(options.sources);

  const store = createInMemoryStore();
  const { logger, warns } = createTestLogger();
  const health = new HealthTracker({ store, logger });
  cleanups.push(() => store.close());

  const gateway: GatewayHandle = await startGateway({
    registry,
    ...(options.aliasMap !== undefined ? { aliasMap: options.aliasMap } : {}),
    ...(options.ranker !== undefined ? { ranker: options.ranker } : {}),
    ...(options.health === false ? {} : { health }),
    installShutdownHandlers: false,
    logger,
    port: 0,
  });
  cleanups.push(() => {
    void gateway.stop();
  });
  const address = gateway.server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${address.port}`, store, health, loggerWarns: warns };
}

async function postChat(
  url: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = (await response.json()) as Record<string, unknown>;
  return { status: response.status, body: parsed };
}

function contentOf(body: Record<string, unknown>): string {
  const choices = body["choices"] as Array<{ message: { content: string } }>;
  return choices[0]?.message.content ?? "";
}

describe("gateway × health — failover", () => {
  it("fails over to the next alias candidate and records the failure", async () => {
    const flaky = failingSource("flaky", "The service may be temporarily overloaded", 429);
    const steady = okSource("steady", "steady-ok");
    const h = await harness({
      sources: [flaky, steady],
      aliasMap: { "free-test": ["flaky/a", "steady/a"] },
    });

    const response = await postChat(h.url, {
      model: "free-test",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(response.status).toBe(200);
    expect(contentOf(response.body)).toBe("steady-ok");
    expect(flaky.calls).toBe(1);
    expect(steady.calls).toBe(1);

    // ZAI's overload 429 classifies as capacity → the breaker cools the model.
    expect(h.health.state("flaky", "flaky/a")).toBe("cooling");
    expect(h.health.isRoutable("flaky", "flaky/a")).toBe(false);
    const flakyStats = h.store.getStats("flaky", "flaky/a", 60_000);
    expect(flakyStats.requests).toBe(1);
    expect(flakyStats.lastErrorKind).toBe("capacity");

    const steadyStats = h.store.getStats("steady", "steady/a", 60_000);
    expect(steadyStats.requests).toBe(1);
    expect(steadyStats.requestSuccessRate).toBe(1);
    expect(h.loggerWarns.some((line) => line.includes("all upstream candidates failed"))).toBe(false);
  });

  it("never calls a candidate the breaker marked non-routable", async () => {
    const cooling = okSource("cooling", "should-not-run");
    const steady = okSource("steady", "steady-ok");
    const h = await harness({
      sources: [cooling, steady],
      aliasMap: { "free-test": ["cooling/a", "steady/a"] },
    });
    h.health.recordProbe({ sourceId: "cooling", modelId: "cooling/a", ok: false, errorKind: "capacity" });

    const response = await postChat(h.url, {
      model: "free-test",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(response.status).toBe(200);
    expect(contentOf(response.body)).toBe("steady-ok");
    expect(cooling.calls).toBe(0);
    expect(steady.calls).toBe(1);
  });

  it("returns the last upstream error when every candidate fails", async () => {
    const first = failingSource("first", "upstream rate limit exceeded", 429);
    const second = failingSource("second", "upstream rate limit exceeded", 429);
    const h = await harness({
      sources: [first, second],
      aliasMap: { "free-test": ["first/a", "second/a"] },
    });

    const response = await postChat(h.url, {
      model: "free-test",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(response.status).toBe(429);
    expect((response.body["error"] as { message: string }).message).toContain("rate limit");
    expect(first.calls).toBe(1);
    expect(second.calls).toBe(1);
    expect(h.health.state("first", "first/a")).toBe("cooling");
    expect(h.health.state("second", "second/a")).toBe("cooling");
  });

  it("does not retry a request-shape failure on the next source", async () => {
    const badRequest = failingSource("bad", "invalid messages", 400);
    const steady = okSource("steady", "steady-ok");
    const h = await harness({
      sources: [badRequest, steady],
      aliasMap: { "free-test": ["bad/a", "steady/a"] },
    });

    const response = await postChat(h.url, {
      model: "free-test",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(response.status).toBe(400);
    expect(badRequest.calls).toBe(1);
    expect(steady.calls).toBe(0);
    // A client-shape failure is not recorded as a model health signal.
    expect(h.store.getStats("bad", "bad/a", 60_000).requests).toBe(0);
  });

  it("returns 503 when every candidate is cooling/down", async () => {
    const cooling = okSource("cooling", "should-not-run");
    const h = await harness({ sources: [cooling], aliasMap: { "free-test": ["cooling/a"] } });
    h.health.recordProbe({ sourceId: "cooling", modelId: "cooling/a", ok: false, errorKind: "capacity" });

    const response = await postChat(h.url, {
      model: "free-test",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(response.status).toBe(503);
    expect((response.body["error"] as { code: string }).code).toBe("all_candidates_unavailable");
    expect(cooling.calls).toBe(0);
  });
});

describe("gateway × health — ranked aliases and passive recording", () => {
  it("ranks a declared-but-empty alias bucket across the free catalog", async () => {
    const small = okSource("small", "small-ok", 8_000);
    const big = okSource("big", "big-ok", 200_000);
    const h = await harness({
      sources: [small, big],
      aliasMap: { "free-best": [] },
      ranker: (candidates) =>
        [...candidates].sort((a, b) => b.contextWindow - a.contextWindow),
    });

    const response = await postChat(h.url, {
      model: "free-best",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(response.status).toBe(200);
    expect(contentOf(response.body)).toBe("big-ok");
    expect(big.calls).toBe(1);
    expect(small.calls).toBe(0);
  });

  it("records a successful streaming request with TTFT", async () => {
    const source = okSource("solo", "stream-ok");
    const h = await harness({ sources: [source] });

    const response = await fetch(`${h.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "solo/a",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain("stream-ok");

    const stats = h.store.getStats("solo", "solo/a", 60_000);
    expect(stats.requests).toBe(1);
    expect(stats.requestSuccessRate).toBe(1);
    expect(stats.ttftP50Ms).not.toBeNull();
    expect(stats.p50Ms).not.toBeNull();
  });

  it("streams /healthz with a breaker summary", async () => {
    const source = okSource("solo", "ok");
    const h = await harness({ sources: [source] });
    h.health.recordProbe({ sourceId: "solo", modelId: "solo/a", ok: false, errorKind: "capacity" });

    const response = await fetch(`${h.url}/healthz`);
    const body = (await response.json()) as {
      ok: boolean;
      monitor?: { counts: Record<string, number>; models: Array<{ modelId: string; state: string }> };
    };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.monitor?.counts["cooling"]).toBe(1);
    expect(body.monitor?.models.some((row) => row.modelId === "solo/a" && row.state === "cooling")).toBe(true);
  });

  it("omits the monitor block when no health tracker is wired", async () => {
    const source = okSource("solo", "ok");
    const h = await harness({ sources: [source], health: false });

    const response = await fetch(`${h.url}/healthz`);
    const body = (await response.json()) as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(body["monitor"]).toBeUndefined();
  });
});
