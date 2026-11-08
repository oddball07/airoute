import { describe, expect, it } from "vitest";
import type { ModelSpec } from "@airoute/core";
import {
  buildAirouteProvider,
  buildOpencodeConfig,
  gatewayCatalogToSpecs,
  normalizeGatewayBaseUrl,
} from "@airoute/opencode";

const CAT = {
  object: "list",
  data: [
    {
      id: "zai/glm-4.5-flash",
      object: "model",
      created: 0,
      owned_by: "zai",
      label: "GLM-4.5-Flash",
      context_window: 128000,
      free: true,
      caps: { tools: true, vision: false, reasoning: true },
      aliases: ["glm-flash"],
    },
  ],
};

function spec(overrides: Partial<ModelSpec> = {}, id = "zai/glm-4.5-flash"): ModelSpec {
  return {
    id,
    sourceId: "zai",
    sourceModelId: id.replace("zai/", ""),
    label: "GLM-4.5-Flash",
    contextWindow: 128000,
    caps: { tools: true, vision: false, reasoning: true },
    free: true,
    aliases: [],
    ...overrides,
  };
}

describe("normalizeGatewayBaseUrl", () => {
  it("appends /v1 to a bare host", () => {
    expect(normalizeGatewayBaseUrl("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787/v1");
  });

  it("keeps an existing /v1 and trims trailing slashes", () => {
    expect(normalizeGatewayBaseUrl("http://127.0.0.1:8787/v1/")).toBe("http://127.0.0.1:8787/v1");
    expect(normalizeGatewayBaseUrl("http://127.0.0.1:8787/v1")).toBe("http://127.0.0.1:8787/v1");
  });

  it("normalizes whitespace and picks the rightmost path", () => {
    expect(normalizeGatewayBaseUrl("  http://h.example/api/  ")).toBe("http://h.example/api/v1");
  });
});

describe("gatewayCatalogToSpecs", () => {
  it("maps the /v1/models payload to ModelSpecs", () => {
    const specs = gatewayCatalogToSpecs(CAT);
    expect(specs).toHaveLength(1);
    const first = specs[0];
    expect(first).toMatchObject({
      id: "zai/glm-4.5-flash",
      sourceId: "zai",
      sourceModelId: "glm-4.5-flash",
      label: "GLM-4.5-Flash",
      contextWindow: 128000,
      caps: { tools: true, vision: false, reasoning: true },
      aliases: ["glm-flash"],
      free: true,
    });
  });

  it("keeps free models only and drops paid entries silently", () => {
    const specs = gatewayCatalogToSpecs({
      data: [
        { id: "paid/expensive", free: false, owned_by: "paid" },
        { id: "free/ok", free: true, owned_by: "free" },
        { id: "no-flag/entry" },
      ],
    });
    expect(specs.map((s) => s.id)).toEqual(["free/ok"]);
  });

  it("derives sourceId from the id's first path segment when owned_by is missing", () => {
    const specs = gatewayCatalogToSpecs({ data: [{ id: "kimi/k2", free: true }] });
    expect(specs[0]).toMatchObject({ sourceId: "kimi", sourceModelId: "k2" });
  });

  it("defaults label to the id and context/caps/aliases when absent", () => {
    const specs = gatewayCatalogToSpecs({ data: [{ id: "a/b", free: true }] });
    expect(specs[0]).toMatchObject({
      label: "a/b",
      contextWindow: 0,
      caps: { tools: false, vision: false, reasoning: false },
      aliases: [],
    });
  });

  it("rejects malformed payloads", () => {
    expect(() => gatewayCatalogToSpecs(null)).toThrow(/payload must be a JSON object/);
    expect(() => gatewayCatalogToSpecs([])).toThrow(/payload must be a JSON object/);
    expect(() => gatewayCatalogToSpecs({})).toThrow(/missing "data" array/);
    expect(() => gatewayCatalogToSpecs({ data: {} })).toThrow(/missing "data" array/);
    expect(() => gatewayCatalogToSpecs({ data: [42] })).toThrow(/data\[0\] must be a JSON object/);
    expect(() => gatewayCatalogToSpecs({ data: [{ id: 3, free: true }] })).toThrow(
      /data\[0\]\.id must be a non-empty string/,
    );
    expect(() => gatewayCatalogToSpecs({ data: [{ id: "a/b", free: true, caps: "yes" }] })).toThrow(
      /caps must be a JSON object/,
    );
    expect(() => gatewayCatalogToSpecs({ data: [{ id: "a/b", free: true, aliases: "x" }] })).toThrow(
      /aliases must be an array/,
    );
  });

  it("rejects a catalog id containing # (reserved for OpenCode variants)", () => {
    expect(() => gatewayCatalogToSpecs({ data: [{ id: "zai/glm-4.5#thinking", free: true }] })).toThrow(
      /"zai\/glm-4\.5#thinking" contains "#/,
    );
    // Non-free entries are still dropped silently by the free-only gate.
    expect(() => gatewayCatalogToSpecs({ data: [{ id: "a/b#v" }] })).not.toThrow();
    // `/` remains fine.
    expect(() => gatewayCatalogToSpecs({ data: [{ id: "a/b/c", free: true }] })).not.toThrow();
  });
});

describe("buildAirouteProvider", () => {
  it("builds the OpenCode v2 custom-provider block", () => {
    const provider = buildAirouteProvider({
      specs: [spec()],
      aliases: ["free-best"],
      gatewayUrl: "http://127.0.0.1:8787",
    });
    const models = provider["models"] as Record<string, Record<string, unknown>>;
    expect(provider["name"]).toBe("AIRoute");
    expect(provider["package"]).toBe("@opencode/ai/providers/openai-compatible");
    expect(provider["settings"]).toEqual({
      baseURL: "http://127.0.0.1:8787/v1",
      apiKey: "airoute",
    });
    expect(Object.keys(models)).toEqual(["free-best", "zai/glm-4.5-flash"]);
    expect(models["zai/glm-4.5-flash"]).toEqual({
      modelID: "zai/glm-4.5-flash",
      name: "GLM-4.5-Flash",
      capabilities: {
        tools: true,
        input: ["text"],
        output: ["text"],
        reasoning: { supported: true },
      },
      limit: { context: 128000 },
      cost: { input: 0, output: 0 },
    });
    expect(models["free-best"]).toEqual({
      modelID: "free-best",
      name: "free-best",
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      limit: { context: 200000 },
    });
  });

  it("reflects caps: no reasoning key, image input for vision, no limit for 0 context", () => {
    const provider = buildAirouteProvider({
      specs: [spec({ label: "", caps: { tools: false, vision: true, reasoning: false }, contextWindow: 0 }, "x/v")],
      aliases: [],
      gatewayUrl: "http://127.0.0.1:8787/v1",
    });
    const models = provider["models"] as Record<string, Record<string, unknown>>;
    expect(models["x/v"]).toEqual({
      modelID: "x/v",
      name: "x/v",
      capabilities: { tools: false, input: ["text", "image"], output: ["text"] },
      cost: { input: 0, output: 0 },
    });
  });

  it("throws on a non-free spec", () => {
    expect(() =>
      buildAirouteProvider({
        specs: [{ ...spec(), free: false as unknown as true }],
        aliases: [],
        gatewayUrl: "http://127.0.0.1:8787",
      }),
    ).toThrow(/refusing non-free model "zai\/glm-4\.5-flash"/);
  });
});

describe("buildOpencodeConfig", () => {
  const options = { specs: [spec()], aliases: ["free-best"], gatewayUrl: "http://127.0.0.1:8787" };

  it("starts a fresh config with schema, provider and default model", () => {
    const config = buildOpencodeConfig(undefined, options);
    expect(config["$schema"]).toBe("https://opencode.ai/config.json");
    expect(config["model"]).toBe("airoute/free-best");
    const providers = config["providers"] as Record<string, unknown>;
    expect(Object.keys(providers)).toEqual(["airoute"]);
  });

  it("preserves unrelated top-level keys, other providers and an existing $schema", () => {
    const existing = {
      "$schema": "https://opencode.ai/config.json",
      "theme": "tokyonight",
      "keybinds": { "input_clear": "<c-a>" },
      "providers": { "anthropic": { "name": "Anthropic" } },
      "model": "anthropic/claude",
    };
    const config = buildOpencodeConfig(existing, options);
    expect(config["theme"]).toBe("tokyonight");
    expect(config["keybinds"]).toEqual({ "input_clear": "<c-a>" });
    expect(config["model"]).toBe("anthropic/claude");
    const providers = config["providers"] as Record<string, Record<string, unknown>>;
    expect(providers["anthropic"]).toEqual({ "name": "Anthropic" });
    expect(Object.keys(providers).sort()).toEqual(["airoute", "anthropic"]);
  });

  it("is idempotent: merging twice yields the same object", () => {
    const first = buildOpencodeConfig(undefined, options);
    const second = buildOpencodeConfig(first, options);
    expect(second).toEqual(first);
  });

  it("replaces a stale airoute provider wholesale", () => {
    const stale = {
      providers: { airoute: { name: "OLD", models: { "old/model": {} } } },
    };
    const config = buildOpencodeConfig(stale, options);
    const airoute = (config["providers"] as Record<string, Record<string, unknown>>)["airoute"];
    expect(airoute["name"]).toBe("AIRoute");
    expect(airoute["models"]).toMatchObject({ "zai/glm-4.5-flash": { modelID: "zai/glm-4.5-flash" } });
  });

  it("honors defaultModel and keeps an existing root model untouched", () => {
    const withModel = buildOpencodeConfig({ model: "airoute/free-coder" }, { ...options, defaultModel: "free-best" });
    expect(withModel["model"]).toBe("airoute/free-coder");
    const withoutModel = buildOpencodeConfig({}, { ...options, defaultModel: "free-coder" });
    expect(withoutModel["model"]).toBe("airoute/free-coder");
  });

  it("throws when a non-free spec is passed", () => {
    const bad = { ...options, specs: [{ ...spec(), free: false as unknown as true }] };
    expect(() => buildOpencodeConfig(undefined, bad)).toThrow(/free models only/);
  });
});
