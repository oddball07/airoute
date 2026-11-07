import {
  TtlCatalogCache,
  createLogger,
  createSourceRegistry,
  resolveModel,
  type Logger,
  type ModelSpec,
  type Source,
} from "@airoute/core";
import { describe, expect, it, vi } from "vitest";

function modelSpec(id: string, sourceId: string, overrides: Partial<ModelSpec> = {}): ModelSpec {
  const sourceModelId = id.startsWith(`${sourceId}/`) ? id.slice(sourceId.length + 1) : id;
  return {
    id,
    sourceId,
    sourceModelId,
    label: id,
    contextWindow: 4096,
    caps: { tools: true, vision: false, reasoning: false },
    free: true,
    aliases: [],
    ...overrides,
  };
}

function stubSource(
  id: string,
  listModels: () => Promise<ModelSpec[]>,
): Source {
  return {
    id,
    listModels,
    stream: async () => {
      throw new Error("stub source does not stream");
    },
    probe: async () => ({ ok: true, at: new Date().toISOString() }),
  };
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

describe("SourceRegistry", () => {
  it("aggregates models across sources", async () => {
    const registry = createSourceRegistry();
    registry.register(stubSource("a", async () => [modelSpec("a/m1", "a")]));
    registry.register(stubSource("b", async () => [modelSpec("b/m1", "b"), modelSpec("b/m2", "b")]));
    const models = await registry.models();
    expect(models.map((spec) => spec.id).sort()).toEqual(["a/m1", "b/m1", "b/m2"]);
  });

  it("skips a failing source with one warn and keeps the other sources' models", async () => {
    const { logger, lines } = capturingLogger();
    const registry = createSourceRegistry(logger);
    registry.register(stubSource("good", async () => [modelSpec("good/m1", "good")]));
    registry.register(
      stubSource("boom", async () => {
        throw new Error("upstream catalog explosion");
      }),
    );
    registry.register(stubSource("good2", async () => [modelSpec("good2/m2", "good2")]));

    const models = await registry.models();
    expect(models.map((spec) => spec.id)).toEqual(["good/m1", "good2/m2"]);

    const warns = lines.filter((line) => line.includes("failed to list models"));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("source 'boom'");
    expect(warns[0]).toContain("upstream catalog explosion");
  });

  it("exposes register/all/get", () => {
    const registry = createSourceRegistry();
    const source = stubSource("a", async () => []);
    registry.register(source);
    expect(registry.all()).toEqual([source]);
    expect(registry.get("a")).toBe(source);
    expect(registry.get("missing")).toBeUndefined();
    expect(registry.has("a")).toBe(true);
  });
});

describe("SourceRegistry catalog cache", () => {
  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

  it("serves the cached catalog within the TTL and refetches after it expires", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const registry = createSourceRegistry(undefined, { cacheTtlMs: 1_000 });
      registry.register(
        stubSource("a", async () => {
          calls += 1;
          return [modelSpec(`a/m${calls}`, "a")];
        }),
      );

      expect((await registry.models()).map((spec) => spec.id)).toEqual(["a/m1"]);
      expect((await registry.models()).map((spec) => spec.id)).toEqual(["a/m1"]); // within TTL → cached
      expect(calls).toBe(1);

      await vi.advanceTimersByTimeAsync(1_001);
      expect((await registry.models()).map((spec) => spec.id)).toEqual(["a/m2"]);
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("concurrent models() calls share a single in-flight fetch per source", async () => {
    let calls = 0;
    const registry = createSourceRegistry();
    registry.register(
      stubSource("a", async () => {
        calls += 1;
        await sleep(50);
        return [modelSpec(`a/m${calls}`, "a")];
      }),
    );

    const [first, second] = await Promise.all([registry.models(), registry.models()]);
    expect(calls).toBe(1);
    expect(first.map((spec) => spec.id)).toEqual(second.map((spec) => spec.id));
  });

  it("serves a stale catalog and warns when a refresh fails", async () => {
    vi.useFakeTimers();
    try {
      const { logger, lines } = capturingLogger();
      let failing = false;
      const registry = createSourceRegistry(logger, { cacheTtlMs: 500 });
      registry.register(
        stubSource("a", async () => {
          if (failing) throw new Error("catalog service down");
          return [modelSpec("a/m1", "a")];
        }),
      );
      // Warm the cache.
      expect((await registry.models()).map((spec) => spec.id)).toEqual(["a/m1"]);

      await vi.advanceTimersByTimeAsync(501);
      failing = true; // the entry is now expired and the source is down
      expect((await registry.models()).map((spec) => spec.id)).toEqual(["a/m1"]);

      const warns = lines.filter((line) => line.includes("failed to refresh models"));
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain("source 'a'");
      expect(warns[0]).toContain("catalog service down");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a cold failure still skips the source (no cached value to fall back on)", async () => {
    const { logger, lines } = capturingLogger();
    const registry = createSourceRegistry(logger, { cacheTtlMs: 60_000 });
    registry.register(
      stubSource("boom", async () => {
        throw new Error("cold catalog explosion");
      }),
    );
    registry.register(stubSource("good", async () => [modelSpec("good/m1", "good")]));

    const models = await registry.models();
    expect(models.map((spec) => spec.id)).toEqual(["good/m1"]);

    const warns = lines.filter((line) => line.includes("failed to list models"));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("source 'boom'");
    expect(warns[0]).toContain("cold catalog explosion");
  });

  it("cacheTtlMs 0 disables caching (every models() call refetches)", async () => {
    let calls = 0;
    const registry = createSourceRegistry(undefined, { cacheTtlMs: 0 });
    registry.register(
      stubSource("a", async () => {
        calls += 1;
        return [modelSpec(`a/m${calls}`, "a")];
      }),
    );

    await registry.models();
    await registry.models();
    expect(calls).toBe(2);
  });
});

describe("TtlCatalogCache", () => {
  it("round-trips get/put and reports its ttl", () => {
    const cache = new TtlCatalogCache(5_000);
    expect(cache.ttlMs).toBe(5_000);
    expect(cache.get("a")).toBeUndefined();

    cache.put("a", [modelSpec("a/m1", "a")]);
    const entry = cache.get("a");
    expect(entry?.value.map((spec) => spec.id)).toEqual(["a/m1"]);
    expect(typeof entry?.fetchedAtMs).toBe("number");
    expect(cache.get("missing")).toBeUndefined();
  });

  it("rejects non-finite or negative ttls", () => {
    for (const ttl of [-1, NaN, Infinity, "soon"]) {
      expect(() => new TtlCatalogCache(ttl as number)).toThrow(RangeError);
    }
  });
});

describe("resolveModel", () => {
  const registry = createSourceRegistry();
  registry.register(stubSource("mock", async () => [modelSpec("mock/mock/basic", "mock", { aliases: ["mock-basic"] })]));

  it("resolves exact model ids", async () => {
    const result = await resolveModel(registry, "mock/mock/basic");
    expect(result.kind).toBe("exact");
    if (result.kind === "exact") expect(result.spec.sourceId).toBe("mock");
  });

  it("resolves alias buckets from config, preferring present candidates", async () => {
    const aliasMap = { "free-best": ["gone/gone-model", "mock/mock/basic"] };
    const result = await resolveModel(registry, "free-best", { aliasMap });
    expect(result.kind).toBe("alias");
    if (result.kind === "alias") expect(result.spec.id).toBe("mock/mock/basic");
  });

  it("resolves source-declared aliases", async () => {
    const result = await resolveModel(registry, "mock-basic");
    expect(result.kind).toBe("alias");
    if (result.kind === "alias") expect(result.spec.id).toBe("mock/mock/basic");
  });

  it("returns unknown for anything else", async () => {
    const result = await resolveModel(registry, "nope/nope");
    expect(result).toEqual({ kind: "unknown" });
  });
});
