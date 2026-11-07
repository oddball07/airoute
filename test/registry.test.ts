import { createLogger, createSourceRegistry, resolveModel, type Logger, type ModelSpec, type Source } from "@airoute/core";
import { describe, expect, it } from "vitest";

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
