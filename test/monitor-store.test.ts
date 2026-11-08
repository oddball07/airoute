/**
 * MetricsStore tests — SQLite persistence via node:sqlite, in-memory only.
 * No network, no real timers.
 */
import {
  createInMemoryStore,
  MetricsStore,
  percentiles,
} from "@airoute/monitor";
import { afterEach, describe, expect, it } from "vitest";

const stores: MetricsStore[] = [];
function store(): MetricsStore {
  const s = createInMemoryStore();
  stores.push(s);
  return s;
}

afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});

describe("MetricsStore — probes", () => {
  it("records probe runs and aggregates a window", () => {
    const s = store();
    const now = Date.now();
    s.recordProbe({ sourceId: "zai", modelId: "zai/glm-4.5-flash", ok: true, latencyMs: 42, ts: now });
    s.recordProbe({ sourceId: "zai", modelId: "zai/glm-4.5-flash", ok: false, latencyMs: 900, errorKind: "capacity", errorDetail: "overloaded", ts: now + 1 });

    const stats = s.getStats("zai", "zai/glm-4.5-flash", 60_000);
    expect(stats.probes).toBe(2);
    expect(stats.probeSuccessRate).toBeCloseTo(0.5);
    expect(stats.requests).toBe(0);
    expect(stats.requestSuccessRate).toBeNull();
    expect(stats.p50Ms).toBeNull(); // no request latencies yet
    expect(stats.lastSuccessAt).not.toBeNull();
    expect(stats.lastFailureAt).not.toBeNull();
    expect(stats.lastErrorKind).toBe("capacity");
  });

  it("excludes rows outside the rolling window", () => {
    const s = store();
    const now = Date.now();
    s.recordProbe({ sourceId: "a", modelId: "a/m", ok: true, ts: now - 120_000 });
    s.recordProbe({ sourceId: "a", modelId: "a/m", ok: false, errorKind: "server", ts: now - 500 });
    const stats = s.getStats("a", "a/m", 60_000);
    expect(stats.probes).toBe(1);
    expect(stats.probeSuccessRate).toBe(0);
  });

  it("returns null-ish stats for an unknown pair", () => {
    const s = store();
    const stats = s.getStats("nope", "nope/x", 60_000);
    expect(stats).toMatchObject({
      probes: 0,
      probeSuccessRate: null,
      requests: 0,
      requestSuccessRate: null,
      p50Ms: null,
      p95Ms: null,
      ttftP50Ms: null,
      ttftP95Ms: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastErrorKind: null,
    });
  });

  it("lists probe rows newest-first with error details", () => {
    const s = store();
    const now = Date.now();
    s.recordProbe({ sourceId: "a", modelId: "a/m", ok: true, latencyMs: 10, ts: now - 1000 });
    s.recordProbe({
      sourceId: "a",
      modelId: "a/m",
      ok: false,
      errorKind: "timeout",
      errorDetail: "upstream did not respond within 60000ms",
      ts: now,
    });
    const rows = s.probeRunsFor("a", "a/m");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.ok).toBe(false);
    expect(rows[0]?.errorKind).toBe("timeout");
    expect(rows[0]?.errorDetail).toContain("did not respond");
    expect(rows[1]?.ok).toBe(true);
  });
});

describe("MetricsStore — requests", () => {
  it("computes success rate and latency percentiles", () => {
    const s = store();
    const now = Date.now();
    s.recordRequest({ sourceId: "or", modelId: "or/free", outcome: "ok", ttftMs: 100, totalMs: 100, ts: now });
    s.recordRequest({ sourceId: "or", modelId: "or/free", outcome: "ok", ttftMs: 200, totalMs: 200, ts: now + 1 });
    s.recordRequest({ sourceId: "or", modelId: "or/free", outcome: "ok", ttftMs: 300, totalMs: 300, ts: now + 2 });
    s.recordRequest({ sourceId: "or", modelId: "or/free", outcome: "rate_limited", totalMs: 5000, ts: now + 3 });

    const stats = s.getStats("or", "or/free", 60_000);
    expect(stats.requests).toBe(4);
    expect(stats.requestSuccessRate).toBeCloseTo(0.75);
    // total_ms includes the failed request's 5000ms (percentiles cover all rows with a value)
    // nearest-rank p50 of [100, 200, 300, 5000] = round(0.5 * 3) = index 2 → 300
    expect(stats.p50Ms).toBe(300);
    expect(stats.p95Ms).toBe(5000);
    expect(stats.ttftP50Ms).toBe(200);
    expect(stats.ttftP95Ms).toBe(300);
    expect(stats.lastErrorKind).toBe("rate_limited");
  });
});

describe("MetricsStore — breaker state", () => {
  it("upserts and reads persisted breaker rows", () => {
    const s = store();
    s.setBreakerState({
      sourceId: "zai",
      modelId: "zai/glm-4.7-flash",
      breaker: "cooling",
      failureStreak: 2,
      cooldownUntil: 123_456,
      updatedAt: 1000,
    });
    expect(s.getBreakerState("zai", "zai/glm-4.7-flash")).toEqual({
      sourceId: "zai",
      modelId: "zai/glm-4.7-flash",
      breaker: "cooling",
      failureStreak: 2,
      cooldownUntil: 123_456,
      updatedAt: 1000,
    });
    expect(s.getBreakerState("missing", "missing/x")).toBeUndefined();

    s.setBreakerState({
      sourceId: "zai",
      modelId: "zai/glm-4.7-flash",
      breaker: "down",
      failureStreak: 3,
      cooldownUntil: 0,
      updatedAt: 2000,
    });
    expect(s.getBreakerState("zai", "zai/glm-4.7-flash")?.breaker).toBe("down");
    expect(s.getBreakerStates()).toHaveLength(1);
  });
});

describe("MetricsStore — rollups and retention", () => {
  it("upserts rollups keyed by hour/source/model", () => {
    const s = store();
    const hour = 1_700_000_000_000;
    s.upsertRollup({
      hourStart: hour,
      sourceId: "zai",
      modelId: "zai/glm-4.5-flash",
      probes: 4,
      probeOks: 3,
      requests: 10,
      requestOks: 9,
      p50Ms: 120,
      p95Ms: 400,
    });
    // Second write for the same key must update, not duplicate.
    s.upsertRollup({
      hourStart: hour,
      sourceId: "zai",
      modelId: "zai/glm-4.5-flash",
      probes: 5,
      probeOks: 4,
      requests: 11,
      requestOks: 10,
      p50Ms: 130,
      p95Ms: 420,
    });
    const rows = s.getRollups(hour);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ probes: 5, requests: 11, p50Ms: 130, p95Ms: 420 });
    expect(s.getRollups(hour + 1)).toEqual([]);
  });

  it("deletes rows older than a horizon", () => {
    const s = store();
    const now = Date.now();
    s.recordProbe({ sourceId: "a", modelId: "a/m", ok: true, ts: now - 10_000 });
    s.recordProbe({ sourceId: "a", modelId: "a/m", ok: true, ts: now });
    s.recordRequest({ sourceId: "a", modelId: "a/m", outcome: "ok", ts: now - 10_000 });
    s.recordRequest({ sourceId: "a", modelId: "a/m", outcome: "ok", ts: now });

    const removed = s.retainOlderThan(now - 5_000);
    expect(removed).toEqual({ probeRuns: 1, requestEvents: 1 });
    expect(s.probeRunsFor("a", "a/m")).toHaveLength(1);
  });
});

describe("MetricsStore — lifecycle and helpers", () => {
  it("closes idempotently and rejects writes after close", () => {
    const s = new MetricsStore(":memory:");
    expect(s.isClosed).toBe(false);
    s.close();
    s.close(); // idempotent
    expect(s.isClosed).toBe(true);
    expect(() =>
      s.recordProbe({ sourceId: "a", modelId: "a/m", ok: true }),
    ).toThrow("MetricsStore is closed");
  });

  it("percentiles use nearest-rank and handle empty input", () => {
    expect(percentiles([])).toEqual({ p50: null, p95: null });
    expect(percentiles([300, 100, 200])).toEqual({ p50: 200, p95: 300 });
    expect(percentiles([1])).toEqual({ p50: 1, p95: 1 });
    expect(percentiles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toEqual({ p50: 6, p95: 10 });
  });
});
