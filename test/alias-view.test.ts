/**
 * Phase 4 alias UX: catalog descriptions (`describeAliases`) and the CLI
 * presentation layer (`buildAliasViews` / `formatAliasSection`). Offline.
 */
import { describeAliases, type ModelSpec } from "@airoute/core";
import type { CircuitState } from "@airoute/monitor";
import { describe, expect, it } from "vitest";
import {
  aliasModeLabel,
  aliasRetryHint,
  aliasSummary,
  buildAliasViews,
  formatAliasSection,
  type AliasHealth,
} from "../packages/cli/src/alias-view.js";

function spec(id: string, options: { free?: boolean; aliases?: string[] } = {}): ModelSpec {
  return {
    id,
    sourceId: id.split("/")[0] as string,
    sourceModelId: id.split("/").slice(1).join("/"),
    label: id,
    contextWindow: 128_000,
    caps: { tools: true, vision: false, reasoning: false },
    free: (options.free ?? true) as true,
    aliases: options.aliases ?? [],
  };
}

const specs = [spec("a/fast"), spec("a/slow"), spec("b/free")];

/** Deterministic health stub: state per id, fixed retry window. */
function healthStub(stateById: Record<string, CircuitState>, retryInMs = 0): AliasHealth {
  return {
    state: (_sourceId, modelId) => stateById[modelId] ?? "healthy",
    cooldownExpiresAt: () => (retryInMs > 0 ? Date.now() + retryInMs : 0),
  };
}

describe("describeAliases", () => {
  it("keeps explicit bucket order when no ranker is supplied", () => {
    const result = describeAliases(specs, { pinned: ["b/free", "gone/model", "a/fast"] });
    expect(result).toEqual([
      { alias: "pinned", mode: "explicit", fallback: false, candidates: ["b/free", "a/fast"] },
    ]);
  });

  it("applies the ranker so the listed order matches routing", () => {
    const result = describeAliases(specs, { pinned: ["b/free", "a/fast"] }, {
      rankCandidates: (candidates) => [...candidates].reverse(),
    });
    expect(result[0]?.candidates).toEqual(["a/fast", "b/free"]);
  });

  it("marks an empty bucket as auto with the whole free catalog", () => {
    const result = describeAliases(specs, { "free-best": [] });
    expect(result[0]).toMatchObject({ mode: "auto", fallback: false });
    expect(result[0]?.candidates).toEqual(["a/fast", "a/slow", "b/free"]);
  });

  it("reports auto+fallback when a bucket's ids all disappeared", () => {
    const result = describeAliases(specs, { legacy: ["gone/model"] });
    expect(result[0]).toMatchObject({ mode: "auto", fallback: true });
    expect(result[0]?.candidates).toHaveLength(3);
  });

  it("drops paid candidates instead of advertising them", () => {
    const withPaid = [...specs, spec("paid/only", { free: false })];
    const result = describeAliases(withPaid, { pinned: ["paid/only", "a/fast"] });
    expect(result[0]?.candidates).toEqual(["a/fast"]);
  });

  it("flags a model id that shadows an alias name", () => {
    const shadowed = [...specs, spec("free-best")];
    const result = describeAliases(shadowed, { "free-best": [] });
    expect(result[0]).toEqual({
      alias: "free-best",
      mode: "shadowed",
      fallback: false,
      candidates: ["free-best"],
    });
  });
});

describe("buildAliasViews", () => {
  it("lists candidates and picks the first when there is no health data", () => {
    const views = buildAliasViews(specs, { "free-best": [] });
    expect(views).toHaveLength(1);
    expect(views[0]?.best).toBe("a/fast");
    expect(views[0]?.candidates.map((candidate) => candidate.id)).toEqual([
      "a/fast",
      "a/slow",
      "b/free",
    ]);
    expect(views[0]?.candidates[0]?.state).toBeUndefined();
  });

  it("skips cooling candidates for `best` and exposes the retry window", () => {
    const views = buildAliasViews(
      specs,
      { "free-best": ["a/fast", "b/free"] },
      undefined,
      healthStub({ "a/fast": "cooling", "b/free": "degraded" }, 240_000),
    );
    const view = views[0]!;
    expect(view.best).toBe("b/free");
    expect(view.counts).toMatchObject({ healthy: 0, degraded: 1, cooling: 1, down: 0 });
    expect(view.candidates[0]?.retryInMs).toBeGreaterThan(200_000);
    expect(aliasSummary(view, true)).toBe("1 degraded, 1 cooling");
    expect(aliasRetryHint(view)).toMatch(/^retry in ~\d+m$/);
  });

  it("returns a null best when every candidate is down", () => {
    const views = buildAliasViews(
      specs,
      { "free-best": ["a/fast", "b/free"] },
      undefined,
      healthStub({ "a/fast": "down", "b/free": "down" }),
    );
    expect(views[0]?.best).toBeNull();
    expect(aliasSummary(views[0]!, true)).toBe("2 down");
  });
});

describe("alias presentation", () => {
  it("labels fallback buckets distinctly", () => {
    expect(aliasModeLabel({ mode: "auto", fallback: true })).toBe("auto (fallback)");
    expect(aliasModeLabel({ mode: "explicit", fallback: false })).toBe("explicit");
  });

  it("summarizes without health as a plain candidate count", () => {
    const views = buildAliasViews(specs, { "free-best": ["a/fast", "b/free"] });
    expect(aliasSummary(views[0]!, false)).toBe("2 candidates");
  });

  it("renders a table with alias, mode, best and candidates", () => {
    const views = buildAliasViews(specs, { "free-best": [], pinned: ["a/slow"] });
    const lines = formatAliasSection(views, false);
    expect(lines[0]).toBe("aliases:");
    expect(lines[1]).toContain("ALIAS");
    expect(lines[1]).toContain("MODE");
    expect(lines[1]).toContain("BEST");
    expect(lines.join("\n")).toContain("free-best");
    expect(lines.join("\n")).toContain("auto");
    expect(lines.join("\n")).toContain("3 candidates");
    expect(lines.join("\n")).toContain("1 candidate");
  });

  it("shows 'no routable candidate' plus a retry hint when everything is blocked", () => {
    const views = buildAliasViews(
      specs,
      { "free-best": ["a/fast"] },
      undefined,
      healthStub({ "a/fast": "cooling" }, 60_000),
    );
    const lines = formatAliasSection(views, true);
    const text = lines.join("\n");
    expect(text).toContain("(none available)");
    expect(text).toContain("1 cooling");
    expect(text).toContain("retry in ~");
  });

  it("explains an empty alias configuration", () => {
    const lines = formatAliasSection([], false);
    expect(lines[0]).toBe("aliases:");
    expect(lines[1]).toContain("none configured");
  });
});
