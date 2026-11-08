import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConfigError, DEFAULT_MONITOR, loadConfig, type LoadConfigOptions } from "@airoute/core";
import { afterAll, describe, expect, it } from "vitest";

const KNOWN: LoadConfigOptions["knownTypes"] = ["mock", "zai", "openrouter"];

let dir: string | undefined;

async function tempFile(name: string, contents: string): Promise<string> {
  dir = dir ?? (await mkdtemp(path.join(tmpdir(), "airoute-config-")));
  const file = path.join(dir, name);
  await writeFile(file, contents, "utf8");
  return file;
}

afterAll(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("returns defaults when the file is missing", async () => {
    const loaded = await loadConfig(path.join(tmpdir(), "airoute-definitely-missing.json"));
    expect(loaded.fileFound).toBe(false);
    expect(loaded.config.server).toEqual({ host: "127.0.0.1", port: 8787 });
    expect(loaded.config.sources.registry).toEqual([
      { type: "mock", enabled: false },
      { type: "zai", enabled: false },
      { type: "openrouter", enabled: false },
    ]);
    expect(loaded.config.aliases["free-best"]).toEqual([]);
    expect(loaded.warnings).toEqual([]);
  });

  it("gives a readable error for bad JSON", async () => {
    const file = await tempFile("bad.json", "{ not :: json ]");
    await expect(loadConfig(file)).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ConfigError);
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain(file);
      expect(message).toContain("not valid JSON");
      return true;
    });
  });

  it("rejects enabled unknown source types", async () => {
    const file = await tempFile(
      "unknown-enabled.json",
      JSON.stringify({
        server: { host: "127.0.0.1", port: 8787 },
        sources: { registry: [{ type: "totally-unknown", enabled: true }] },
      }),
    );
    await expect(loadConfig(file, { knownTypes: KNOWN })).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ConfigError);
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain("unknown source type \"totally-unknown\"");
      expect(message).toContain("sources.registry[0].type");
      return true;
    });
  });

  it("tolerates disabled unknown source types with a warning", async () => {
    const file = await tempFile(
      "unknown-disabled.json",
      JSON.stringify({
        server: { host: "127.0.0.1", port: 8787 },
        sources: { registry: [{ type: "totally-unknown", enabled: false }] },
      }),
    );
    const loaded = await loadConfig(file, { knownTypes: KNOWN });
    expect(loaded.warnings).toHaveLength(1);
    expect(loaded.warnings[0]).toContain("totally-unknown");
  });

  it("applies defaults for omitted sections and validates values", async () => {
    const file = await tempFile(
      "partial.json",
      JSON.stringify({ sources: { registry: [] } }),
    );
    const loaded = await loadConfig(file, { knownTypes: KNOWN });
    expect(loaded.fileFound).toBe(true);
    // server/rank/aliases fall back to defaults when omitted
    expect(loaded.config.server).toEqual({ host: "127.0.0.1", port: 8787 });
    expect(loaded.config.rank.weights).toEqual({
      uptime: 0.35,
      quota: 0.25,
      latency: 0.2,
      context: 0.1,
      capability: 0.1,
    });
    expect(loaded.config.aliases["free-best"]).toEqual([]);
  });

  it("rejects out-of-range ports with a precise path", async () => {
    const file = await tempFile(
      "bad-port.json",
      JSON.stringify({ server: { host: "127.0.0.1", port: 99999 }, sources: { registry: [] } }),
    );
    await expect(loadConfig(file)).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toContain("server.port");
      expect((err as Error).message).toContain("1 and 65535");
      return true;
    });
  });

  it("rejects malformed alias values", async () => {
    const file = await tempFile(
      "bad-aliases.json",
      JSON.stringify({
        server: { host: "127.0.0.1", port: 8787 },
        sources: { registry: [] },
        aliases: { "free-best": "not-an-array" },
      }),
    );
    await expect(loadConfig(file)).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toContain('aliases["free-best"]');
      return true;
    });
  });
});

describe("loadConfig — monitor section", () => {
  it("leaves monitor undefined when the section is omitted", async () => {
    const file = await tempFile("no-monitor.json", JSON.stringify({ sources: { registry: [] } }));
    const loaded = await loadConfig(file);
    expect(loaded.config.monitor).toBeUndefined();
  });

  it("fills monitor defaults when the section is present but empty", async () => {
    const file = await tempFile("empty-monitor.json", JSON.stringify({ monitor: {} }));
    const loaded = await loadConfig(file);
    expect(loaded.config.monitor).toEqual(DEFAULT_MONITOR);
  });

  it("accepts monitor overrides", async () => {
    const monitor = {
      enabled: false,
      probeEveryMs: 60_000,
      jitterMs: 0,
      requestFailureWindowMs: 1_000,
      cooldownMs: 2_000,
    };
    const file = await tempFile("monitor-overrides.json", JSON.stringify({ monitor }));
    const loaded = await loadConfig(file);
    expect(loaded.config.monitor).toEqual(monitor);
  });

  it.each([
    [{ probeEveryMs: 9_999 }, "monitor.probeEveryMs"],
    [{ probeEveryMs: 1.5 }, "monitor.probeEveryMs"],
    [{ jitterMs: -1 }, "monitor.jitterMs"],
    [{ jitterMs: 600_001 }, "monitor.jitterMs"],
    [{ requestFailureWindowMs: 0 }, "monitor.requestFailureWindowMs"],
    [{ cooldownMs: 0 }, "monitor.cooldownMs"],
    [{ enabled: "yes" }, "monitor.enabled"],
    ["not-an-object", "monitor"],
  ] as const)("rejects invalid monitor config %j", async (monitor, expectedPath) => {
    const file = await tempFile(
      `bad-monitor-${Math.random().toString(36).slice(2)}.json`,
      JSON.stringify({ monitor }),
    );
    await expect(loadConfig(file)).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toContain(expectedPath);
      return true;
    });
  });
});
