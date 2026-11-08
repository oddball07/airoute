import { describe, expect, it } from "vitest";
import { fetchGatewayCatalog } from "@airoute/opencode";

/** Fake `fetch`: no network, returns the gateway's /v1/models payload. */
function fakeFetch(payload: unknown, status = 200) {
  const calls: string[] = [];
  const impl: typeof fetch = (async (input: unknown) => {
    calls.push(String(input));
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
    } as unknown as Response;
  }) as typeof fetch;
  return { impl, calls };
}

describe("fetchGatewayCatalog", () => {
  it("GETs <baseUrl>/v1/models and parses free-only specs plus gateway aliases", async () => {
    const payload = {
      object: "list",
      aliases: ["free-best", "free-fast"],
      data: [
        { id: "zai/glm-4.5-flash", free: true, owned_by: "zai", label: "GLM-4.5-Flash", context_window: 128000, caps: { tools: true, vision: false, reasoning: true }, aliases: [] },
        { id: "paid/other", free: false },
      ],
    };
    const { impl, calls } = fakeFetch(payload);
    const catalog = await fetchGatewayCatalog("http://127.0.0.1:8787", impl);
    expect(calls).toEqual(["http://127.0.0.1:8787/v1/models"]);
    expect(catalog.specs).toHaveLength(1);
    expect(catalog.specs[0]).toMatchObject({ id: "zai/glm-4.5-flash", free: true });
    expect(catalog.aliases).toEqual(["free-best", "free-fast"]);
  });

  it("tolerates a catalog payload without an aliases array", async () => {
    const { impl } = fakeFetch({ data: [] });
    const catalog = await fetchGatewayCatalog("http://127.0.0.1:8787", impl);
    expect(catalog.specs).toEqual([]);
    expect(catalog.aliases).toEqual([]);
  });

  it("normalizes a /v1-suffixed base URL without double-appending", async () => {
    const { impl, calls } = fakeFetch({ data: [] });
    await fetchGatewayCatalog("http://127.0.0.1:8787/v1/", impl);
    expect(calls).toEqual(["http://127.0.0.1:8787/v1/models"]);
  });

  it("throws on non-2xx responses", async () => {
    const { impl } = fakeFetch({ error: "boom" }, 500);
    await expect(fetchGatewayCatalog("http://127.0.0.1:8787", impl)).rejects.toThrow(
      /returned HTTP 500/,
    );
  });

  it("throws on a malformed payload", async () => {
    const { impl } = fakeFetch({ nope: true });
    await expect(fetchGatewayCatalog("http://127.0.0.1:8787", impl)).rejects.toThrow(
      /missing "data" array/,
    );
  });

  it("wraps transport failures", async () => {
    const impl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(fetchGatewayCatalog("http://127.0.0.1:8787", impl)).rejects.toThrow(/ECONNREFUSED/);
  });
});
