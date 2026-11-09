/**
 * Phase 7 dashboard: snapshot derivation (uptime buckets, rankings, aliases,
 * failure pressure) and the HTTP surface (`/dashboard`, snapshot JSON).
 * Loopback gateway + in-memory SQLite; no external network.
 */
import { type AddressInfo } from "node:net";
import type { ReadableStream } from "node:stream/web";
import {
  createSourceRegistry,
  type IRChunk,
  type ModelSpec,
  type Source,
} from "@airoute/core";
import {
  DASHBOARD_PATH,
  DASHBOARD_SNAPSHOT_PATH,
  DASHBOARD_WINDOW_MS,
  buildDashboardSnapshot,
  renderDashboardPage,
  startGateway,
  type GatewayHandle,
} from "@airoute/gateway";
import {
  HealthTracker,
  createInMemoryStore,
  type MetricsStore,
} from "@airoute/monitor";
import { afterEach, describe, expect, it } from "vitest";

function spec(id: string, contextWindow = 128_000): ModelSpec {
  return {
    id,
    sourceId: id.split("/")[0] as string,
    sourceModelId: id.split("/").slice(1).join("/"),
    label: id,
    contextWindow,
    caps: { tools: true, vision: false, reasoning: false },
    free: true,
    aliases: [],
  };
}

const HOUR = 60 * 60 * 1000;

/** Two-model fixture: `a/one` healthy, `a/two` cooling; both on source `a`. */
function fixture(now: number): {
  store: MetricsStore;
  health: HealthTracker;
  specs: ModelSpec[];
  aliasMap: Record<string, string[]>;
} {
  const store = createInMemoryStore();
  const health = new HealthTracker({ store });
  const specs = [spec("a/one"), spec("a/two")];

  // Bucket -1h and -2h observations for the heatmap.
  store.recordProbe({
    sourceId: "a",
    modelId: "a/one",
    ok: true,
    latencyMs: 90,
    ts: now - 30 * 60_000,
  });
  store.recordProbe({
    sourceId: "a",
    modelId: "a/one",
    ok: false,
    errorKind: "capacity",
    ts: now - 2 * HOUR,
  });
  store.recordRequest({
    sourceId: "a",
    modelId: "a/one",
    outcome: "ok",
    ttftMs: 120,
    totalMs: 500,
    ts: now - 20 * 60_000,
  });

  // Two capacity probe failures cool `a/two` (default breaker thresholds).
  health.recordProbe({ sourceId: "a", modelId: "a/two", ok: false, errorKind: "capacity", ts: now - 10_000 });
  health.recordProbe({ sourceId: "a", modelId: "a/two", ok: false, errorKind: "capacity", ts: now - 9_000 });

  const aliasMap = { pick: ["a/two", "a/one"] };
  return { store, health, specs, aliasMap };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("buildDashboardSnapshot", () => {
  it("ranks models, exposes state and counts", () => {
    const now = Date.now();
    const { store, health, specs, aliasMap } = fixture(now);
    cleanups.push(() => store.close());

    const snapshot = buildDashboardSnapshot({
      specs,
      aliasMap,
      health,
      store,
      ranker: (candidates) => candidates,
      version: "9.9.9",
      now,
      startedAt: now - 90_000,
    });

    expect(snapshot.version).toBe("9.9.9");
    expect(snapshot.uptimeMs).toBe(90_000);
    expect(snapshot.summary).toMatchObject({
      models: 2,
      routable: 1,
      counts: { healthy: 1, degraded: 0, cooling: 1, down: 0 },
      sources: 1,
    });

    const one = snapshot.models.find((model) => model.id === "a/one");
    const two = snapshot.models.find((model) => model.id === "a/two");
    expect(one?.state).toBe("healthy");
    expect(two?.state).toBe("cooling");
    expect(two?.score).toBe(0);
    expect(two?.cooldownMsRemaining).toBeGreaterThan(0);
    // Ranking sorts routable models first.
    expect(snapshot.models[0]?.id).toBe("a/one");
  });

  it("fills fixed-length hourly buckets from probes and requests", () => {
    const now = Date.now();
    const { store, health, specs, aliasMap } = fixture(now);
    cleanups.push(() => store.close());

    const snapshot = buildDashboardSnapshot({
      specs,
      aliasMap,
      health,
      store,
      version: "0.1.0",
      now,
    });

    expect(snapshot.window).toEqual({
      ms: DASHBOARD_WINDOW_MS,
      bucketMs: HOUR,
      count: 24,
    });
    const cells = snapshot.models.find((model) => model.id === "a/one")!.buckets;
    expect(cells).toHaveLength(24);
    const since = now - DASHBOARD_WINDOW_MS;
    const bucketOf = (ts: number): number => Math.floor((ts - since) / HOUR);

    const okCell = cells[bucketOf(now - 30 * 60_000)]!;
    expect(okCell).toMatchObject({ probes: 1, probeOks: 1, requests: 1, requestOks: 1, rate: 1 });
    const failCell = cells[bucketOf(now - 2 * HOUR)]!;
    expect(failCell).toMatchObject({ probes: 1, probeOks: 0, rate: 0 });

    // The cooling model still gets a full row (empty buckets, not dropped).
    expect(snapshot.models.find((model) => model.id === "a/two")!.buckets).toHaveLength(24);
  });

  it("derives alias routing from the same candidates and health", () => {
    const now = Date.now();
    const { store, health, specs, aliasMap } = fixture(now);
    cleanups.push(() => store.close());

    const snapshot = buildDashboardSnapshot({
      specs,
      aliasMap,
      health,
      store,
      ranker: (candidates) => candidates,
      version: "0.1.0",
      now,
    });

    expect(snapshot.aliases).toHaveLength(1);
    expect(snapshot.aliases[0]).toMatchObject({
      alias: "pick",
      mode: "explicit",
      best: "a/one",
      counts: { healthy: 1, degraded: 0, cooling: 1, down: 0 },
    });
    expect(snapshot.aliases[0]?.candidates).toEqual(["a/two", "a/one"]);
  });

  it("computes per-source availability and failure pressure", () => {
    const now = Date.now();
    const { store, health, specs, aliasMap } = fixture(now);
    cleanups.push(() => store.close());

    const snapshot = buildDashboardSnapshot({
      specs,
      aliasMap,
      health,
      store,
      version: "0.1.0",
      now,
    });

    const source = snapshot.sources[0]!;
    expect(source.id).toBe("a");
    expect(source.models).toBe(2);
    expect(source.counts).toMatchObject({ healthy: 1, cooling: 1 });
    expect(source.availability).toBe(0.5);
    // Every failure in the fixture is a capacity failure.
    expect(source.totalFailures).toBeGreaterThanOrEqual(3);
    expect(source.quotaPressure).toBe(1);
    expect(source.failures["capacity"]).toBeGreaterThanOrEqual(3);
  });

  it("lists recent activity newest-first with both kinds", () => {
    const now = Date.now();
    const { store, health, specs, aliasMap } = fixture(now);
    cleanups.push(() => store.close());

    const snapshot = buildDashboardSnapshot({
      specs,
      aliasMap,
      health,
      store,
      version: "0.1.0",
      now,
      recentLimit: 10,
    });

    expect(snapshot.recent.length).toBeGreaterThanOrEqual(3);
    const kinds = new Set(snapshot.recent.map((row) => row.kind));
    expect(kinds.has("probe")).toBe(true);
    expect(kinds.has("request")).toBe(true);
    for (let i = 1; i < snapshot.recent.length; i++) {
      expect(snapshot.recent[i - 1]!.ts).toBeGreaterThanOrEqual(snapshot.recent[i]!.ts);
    }
  });

  it("works without a store (empty buckets, null stats)", () => {
    const now = Date.now();
    const snapshot = buildDashboardSnapshot({
      specs: [spec("a/one")],
      version: "0.1.0",
      now,
    });
    const model = snapshot.models[0]!;
    expect(model.uptime).toBeNull();
    expect(model.buckets).toHaveLength(24);
    expect(model.buckets.every((cell) => cell.rate === null)).toBe(true);
    expect(snapshot.recent).toEqual([]);
    expect(snapshot.sources[0]?.quotaPressure).toBeNull();
  });
});

describe("dashboard page", () => {
  it("is self-contained: no external assets, snapshot URL present", () => {
    const html = renderDashboardPage();
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("AIRoute");
    expect(html).toContain(DASHBOARD_SNAPSHOT_PATH);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toContain("<script src=");
  });
});

/* -------------------------------------------------------------------------- */
/* HTTP surface                                                               */
/* -------------------------------------------------------------------------- */

function okStream(): ReadableStream<IRChunk> {
  return new ReadableStream<IRChunk>({
    start(controller) {
      controller.enqueue({ index: 0, role: "assistant" });
      controller.enqueue({ index: 1, content: "ok" });
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
    return Promise.resolve(okStream());
  }
  probe(): Promise<{ ok: boolean; at: string }> {
    return Promise.resolve({ ok: true, at: new Date().toISOString() });
  }
}

async function startDashboardGateway(
  dashboard: { store?: MetricsStore } = {},
): Promise<{ handle: GatewayHandle; store: MetricsStore; health: HealthTracker }> {
  const now = Date.now();
  const store = dashboard.store ?? createInMemoryStore();
  const health = new HealthTracker({ store });
  const specs = [spec("a/one"), spec("a/two")];
  health.recordProbe({ sourceId: "a", modelId: "a/two", ok: false, errorKind: "capacity", ts: now - 5_000 });
  health.recordProbe({ sourceId: "a", modelId: "a/two", ok: false, errorKind: "capacity", ts: now - 4_000 });
  store.recordProbe({ sourceId: "a", modelId: "a/one", ok: true, ts: now - 1_000 });

  const registry = createSourceRegistry();
  registry.register(new MiniSource("a", specs));

  const handle = await startGateway({
    registry,
    aliasMap: { pick: ["a/two", "a/one"] },
    health,
    ranker: (candidates) => candidates,
    dashboard: {
      store,
      startedAt: now - 60_000,
      configPath: "config/airoute.json",
    },
    installShutdownHandlers: false,
    port: 0,
  });
  return { handle, store, health };
}

function urlOf(handle: GatewayHandle): string {
  return `http://127.0.0.1:${(handle.server.address() as AddressInfo).port}`;
}

describe("dashboard HTTP routes", () => {
  it("serves the page as HTML and the snapshot as JSON", async () => {
    const { handle, store } = await startDashboardGateway();
    cleanups.push(() => void handle.stop());
    cleanups.push(() => store.close());
    const base = urlOf(handle);

    const page = await fetch(`${base}${DASHBOARD_PATH}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("gateway dashboard");

    const response = await fetch(`${base}${DASHBOARD_SNAPSHOT_PATH}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      version: string;
      configPath: string;
      summary: { models: number };
      models: Array<{ id: string; buckets: unknown[] }>;
      aliases: Array<{ alias: string; best: string }>;
    };
    expect(body.configPath).toBe("config/airoute.json");
    expect(body.summary.models).toBe(2);
    expect(body.models.every((model) => model.buckets.length === 24)).toBe(true);
    expect(body.aliases[0]).toMatchObject({ alias: "pick", best: "a/one" });
  });

  it("still answers without a store attached", async () => {
    const registry = createSourceRegistry();
    registry.register(new MiniSource("a", [spec("a/one")]));
    const handle = await startGateway({
      registry,
      installShutdownHandlers: false,
      port: 0,
    });
    cleanups.push(() => void handle.stop());

    const response = await fetch(`${urlOf(handle)}${DASHBOARD_SNAPSHOT_PATH}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      models: Array<{ id: string; uptime: null }>;
      summary: { models: number };
    };
    expect(body.summary.models).toBe(1);
    expect(body.models[0]?.uptime).toBeNull();
  });

  it("lists /dashboard in the root endpoint index", async () => {
    const registry = createSourceRegistry();
    const handle = await startGateway({ registry, installShutdownHandlers: false, port: 0 });
    cleanups.push(() => void handle.stop());
    const body = (await (await fetch(urlOf(handle))).json()) as { endpoints: string[] };
    expect(body.endpoints).toContain(DASHBOARD_PATH);
  });
});
