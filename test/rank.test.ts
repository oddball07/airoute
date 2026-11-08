/**
 * Model ranking tests — pure scoring math, no network or timers.
 */
import type { ModelSpec, RankWeights } from "@airoute/core";
import { rankCandidateSpecs, rankModels, scoreModel, type StatsSnapshot } from "@airoute/monitor";
import { describe, expect, it } from "vitest";

function spec(id: string, overrides: Partial<ModelSpec> = {}): ModelSpec {
  return {
    id,
    sourceId: id.split("/")[0] as string,
    sourceModelId: id.split("/").slice(1).join("/"),
    label: id,
    contextWindow: 128_000,
    caps: { tools: false, vision: false, reasoning: false },
    free: true,
    aliases: [],
    ...overrides,
  };
}

function stats(overrides: Partial<StatsSnapshot> = {}): StatsSnapshot {
  return {
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
    ...overrides,
  };
}

function weights(overrides: Partial<RankWeights> = {}): RankWeights {
  return { uptime: 0, quota: 0, latency: 0, context: 0, capability: 0, ...overrides };
}

describe("scoreModel — components", () => {
  it("scores uptime from the probe success rate, falling back to requests", () => {
    const w = weights({ uptime: 1 });
    expect(scoreModel({ spec: spec("a/m"), stats: stats({ probeSuccessRate: 0.8 }) }, w).score).toBeCloseTo(0.8);
    expect(
      scoreModel({ spec: spec("a/m"), stats: stats({ requestSuccessRate: 0.25 }) }, w).score,
    ).toBeCloseTo(0.25);
  });

  it("uses a neutral 0.5 uptime when there is no data", () => {
    const result = scoreModel({ spec: spec("a/m"), stats: null }, weights({ uptime: 1 }));
    expect(result.score).toBeCloseTo(0.5);
    expect(result.breakdown.uptime).toBe(0.5);
  });

  it("inverts latency against the target", () => {
    const w = weights({ latency: 1 });
    const target = 10_000;
    expect(
      scoreModel({ spec: spec("a/m"), stats: stats({ p50Ms: 0 }) }, w, { latencyTargetMs: target })
        .breakdown.latency,
    ).toBe(1);
    expect(
      scoreModel({ spec: spec("a/m"), stats: stats({ p50Ms: 5_000 }) }, w, { latencyTargetMs: target })
        .breakdown.latency,
    ).toBeCloseTo(0.5);
    expect(
      scoreModel({ spec: spec("a/m"), stats: stats({ p50Ms: 25_000 }) }, w, { latencyTargetMs: target })
        .breakdown.latency,
    ).toBe(0);
    expect(scoreModel({ spec: spec("a/m"), stats: null }, w).breakdown.latency).toBe(0.5);
  });

  it("normalizes the context window against the target", () => {
    const w = weights({ context: 1 });
    const options = { contextTarget: 200_000 };
    expect(scoreModel({ spec: spec("a/m", { contextWindow: 200_000 }) }, w, options).score).toBe(1);
    expect(scoreModel({ spec: spec("a/m", { contextWindow: 100_000 }) }, w, options).score).toBeCloseTo(0.5);
    expect(scoreModel({ spec: spec("a/m", { contextWindow: 0 }) }, w, options).score).toBe(0);
  });

  it("scores capability flags 0.5 / 0.25 / 0.25", () => {
    const w = weights({ capability: 1 });
    const full = spec("a/m", { caps: { tools: true, vision: true, reasoning: true } });
    const toolsOnly = spec("a/m", { caps: { tools: true, vision: false, reasoning: false } });
    const none = spec("a/m");
    expect(scoreModel({ spec: full }, w).score).toBe(1);
    expect(scoreModel({ spec: toolsOnly }, w).score).toBeCloseTo(0.5);
    expect(scoreModel({ spec: none }, w).score).toBe(0);
  });

  it("penalizes the quota component for recent failures", () => {
    const w = weights({ quota: 1 });
    expect(scoreModel({ spec: spec("a/m"), stats: stats() }, w).score).toBe(1);
    expect(
      scoreModel({ spec: spec("a/m"), stats: stats({ lastErrorKind: "capacity" }) }, w).score,
    ).toBeCloseTo(0.4);
    expect(scoreModel({ spec: spec("a/m"), stats: stats({ lastErrorKind: "auth" }) }, w).score).toBe(0);
    expect(
      scoreModel({ spec: spec("a/m"), stats: stats({ lastErrorKind: "server" }) }, w).score,
    ).toBeCloseTo(0.7);
    // Client disconnects are neutral for health and must not penalize quota.
    expect(
      scoreModel({ spec: spec("a/m"), stats: stats({ lastErrorKind: "drop" }) }, w).score,
    ).toBe(1);
    expect(
      scoreModel({ spec: spec("a/m"), state: "degraded", stats: stats() }, w).score,
    ).toBeCloseTo(0.6);
  });

  it("marks cooling/down models non-routable with score 0", () => {
    const w = weights({ uptime: 1 });
    const cooling = scoreModel({ spec: spec("a/m"), state: "cooling", stats: stats({ probeSuccessRate: 1 }) }, w);
    const down = scoreModel({ spec: spec("a/m"), state: "down" }, w);
    expect(cooling.routable).toBe(false);
    expect(cooling.score).toBe(0);
    expect(down.routable).toBe(false);
    expect(down.score).toBe(0);
  });

  it("normalizes by the weight total (alias weight boosts are safe)", () => {
    const result = scoreModel(
      { spec: spec("a/m"), stats: stats({ probeSuccessRate: 1 }) },
      { uptime: 0.5, quota: 1.5, latency: 0.5, context: 0.5, capability: 0 },
    );
    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });
});

describe("rankModels / rankCandidateSpecs", () => {
  it("sorts routable first, then by score, then by id", () => {
    const w = weights({ uptime: 1 });
    const ranked = rankModels(
      [
        { spec: spec("b/best"), stats: stats({ probeSuccessRate: 1 }) },
        { spec: spec("a/worse"), stats: stats({ probeSuccessRate: 0.2 }) },
        { spec: spec("c/cooling"), state: "cooling", stats: stats({ probeSuccessRate: 1 }) },
        { spec: spec("a/tie"), stats: stats({ probeSuccessRate: 0.2 }) },
      ],
      w,
    );
    expect(ranked.map((row) => row.spec.id)).toEqual(["b/best", "a/tie", "a/worse", "c/cooling"]);
  });

  it("orders candidate specs by their lookup scores", () => {
    const w = weights({ uptime: 1 });
    const candidates = [spec("a/one"), spec("b/two"), spec("c/three")];
    const rates: Record<string, number> = { "a/one": 0.3, "b/two": 0.9, "c/three": 0.6 };
    const ordered = rankCandidateSpecs(
      candidates,
      (model) => ({ spec: model, stats: stats({ probeSuccessRate: rates[model.id] ?? 0 }) }),
      w,
    );
    expect(ordered.map((model) => model.id)).toEqual(["b/two", "c/three", "a/one"]);
  });
});
