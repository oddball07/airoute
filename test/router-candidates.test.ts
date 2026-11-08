/**
 * `resolveCandidates` tests — exact match, alias buckets, ranked fallback for
 * empty buckets, source-declared aliases and the single-pick wrapper.
 */
import { resolveCandidates, resolveModelFromSpecs, type ModelSpec } from "@airoute/core";
import { describe, expect, it } from "vitest";

function spec(id: string, aliases: string[] = []): ModelSpec {
  return {
    id,
    sourceId: id.split("/")[0] as string,
    sourceModelId: id.split("/").slice(1).join("/"),
    label: id,
    contextWindow: 8192,
    caps: { tools: false, vision: false, reasoning: false },
    free: true,
    aliases,
  };
}

const specs = [
  spec("zai/glm-4.5-flash", ["glm-flash"]),
  spec("openrouter/free", ["glm-flash"]),
  spec("openrouter/nemotron:free"),
];

const reverse = (candidates: readonly ModelSpec[]): readonly ModelSpec[] =>
  [...candidates].sort((a, b) => b.id.localeCompare(a.id));

describe("resolveCandidates", () => {
  it("resolves an exact id without consulting the ranker", () => {
    let ranked = false;
    const result = resolveCandidates(specs, "zai/glm-4.5-flash", {
      rankCandidates: (candidates) => {
        ranked = true;
        return candidates;
      },
    });
    expect(result.kind).toBe("exact");
    expect(result.candidates.map((model) => model.id)).toEqual(["zai/glm-4.5-flash"]);
    expect(ranked).toBe(false);
  });

  it("returns every present candidate of an alias bucket in order", () => {
    const result = resolveCandidates(specs, "free-best", {
      aliasMap: { "free-best": ["openrouter/free", "gone/model", "zai/glm-4.5-flash"] },
    });
    expect(result.kind).toBe("alias");
    expect(result.candidates.map((model) => model.id)).toEqual([
      "openrouter/free",
      "zai/glm-4.5-flash",
    ]);
  });

  it("applies the ranker to alias candidates", () => {
    const result = resolveCandidates(specs, "free-best", {
      aliasMap: { "free-best": ["openrouter/free", "zai/glm-4.5-flash"] },
      rankCandidates: reverse,
    });
    expect(result.candidates.map((model) => model.id)).toEqual([
      "zai/glm-4.5-flash",
      "openrouter/free",
    ]);
  });

  it("falls back to the whole catalog for a declared-but-empty bucket", () => {
    const result = resolveCandidates(specs, "free-best", {
      aliasMap: { "free-best": [] },
      rankCandidates: reverse,
    });
    expect(result.kind).toBe("alias");
    expect(result.candidates).toHaveLength(specs.length);
    expect(result.candidates[0]?.id).toBe("zai/glm-4.5-flash");
  });

  it("leaves an empty bucket unknown without a ranker", () => {
    const result = resolveCandidates(specs, "free-best", { aliasMap: { "free-best": [] } });
    expect(result.kind).toBe("unknown");
    expect(result.candidates).toEqual([]);
  });

  it("resolves source-declared aliases across sources", () => {
    const result = resolveCandidates(specs, "glm-flash", {
      rankCandidates: (candidates, alias) => {
        expect(alias).toBe("glm-flash");
        return reverse(candidates);
      },
    });
    expect(result.kind).toBe("alias");
    expect(result.candidates.map((model) => model.id)).toEqual([
      "zai/glm-4.5-flash",
      "openrouter/free",
    ]);
  });

  it("returns unknown for a name nothing matches", () => {
    const result = resolveCandidates(specs, "nope/nothing", { aliasMap: { "free-best": [] } });
    expect(result.kind).toBe("unknown");
    expect(result.candidates).toEqual([]);
  });

  it("passes the alias name to the ranker", () => {
    const seen: string[] = [];
    resolveCandidates(specs, "free-best", {
      aliasMap: { "free-best": ["zai/glm-4.5-flash", "openrouter/free"] },
      rankCandidates: (candidates, alias) => {
        seen.push(alias);
        return candidates;
      },
    });
    expect(seen).toEqual(["free-best"]);
  });
});

describe("resolveModelFromSpecs", () => {
  it("returns the first ranked candidate under kind alias", () => {
    const result = resolveModelFromSpecs(specs, "free-best", {
      aliasMap: { "free-best": ["zai/glm-4.5-flash", "openrouter/free"] },
      rankCandidates: reverse,
    });
    expect(result).toEqual({ kind: "alias", spec: specs[0] });
  });

  it("still reports unknown for an unknown name", () => {
    expect(resolveModelFromSpecs(specs, "nope/nothing")).toEqual({ kind: "unknown" });
  });
});
