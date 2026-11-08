/**
 * `probeOne` tests — success passthrough, rejection mapping and the timeout
 * wrapper. Uses real timers with tiny timeouts (no network).
 */
import type { IRChunk, IRRequest, ModelSpec, ProbeResult, Source } from "@airoute/core";
import { DEFAULT_PROBE_TIMEOUT_MS, probeOne } from "@airoute/monitor";
import { describe, expect, it } from "vitest";

const MODEL: ModelSpec = {
  id: "fake/basic",
  sourceId: "fake",
  sourceModelId: "basic",
  label: "basic",
  contextWindow: 4096,
  caps: { tools: false, vision: false, reasoning: false },
  free: true,
  aliases: [],
};

function sourceWithProbe(probe: (model: ModelSpec) => Promise<ProbeResult>): Source {
  return {
    id: "fake",
    listModels: async () => [MODEL],
    stream: (_req: { model: ModelSpec; request: IRRequest }): Promise<ReadableStream<IRChunk>> =>
      Promise.reject(new Error("not used")),
    probe,
  };
}

describe("probeOne", () => {
  it("returns the source result unchanged on success", async () => {
    const expected: ProbeResult = { ok: true, latencyMs: 12, at: new Date().toISOString() };
    const result = await probeOne(sourceWithProbe(async () => expected), MODEL, 1_000);
    expect(result).toBe(expected);
  });

  it("maps a rejected probe to a probe_failed result", async () => {
    const result = await probeOne(
      sourceWithProbe(async () => {
        throw new Error("boom");
      }),
      MODEL,
      1_000,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe("probe_failed");
    expect(typeof result.latencyMs).toBe("number");
  });

  it("returns a timeout result instead of hanging on a stuck probe", async () => {
    let resolveProbe!: (result: ProbeResult) => void;
    const stuck = new Promise<ProbeResult>((resolve) => {
      resolveProbe = resolve;
    });
    const startedAt = Date.now();
    const result = await probeOne(sourceWithProbe(() => stuck), MODEL, 25);
    const elapsed = Date.now() - startedAt;

    expect(result.ok).toBe(false);
    expect(result.error).toBe("timeout");
    expect(result.latencyMs).toBe(25);
    expect(elapsed).toBeGreaterThanOrEqual(20);
    expect(elapsed).toBeLessThan(5_000);

    // The late resolution is harmless and must not throw.
    resolveProbe({ ok: true, latencyMs: 1, at: new Date().toISOString() });
  });

  it("exposes the 30s default timeout", () => {
    expect(DEFAULT_PROBE_TIMEOUT_MS).toBe(30_000);
  });
});
