/**
 * Registry/gateway integration with the zai source: env-key gating → factory
 * wiring → routing, end-to-end over the gateway HTTP surface against the
 * deterministic mock provider (loopback; no real network).
 *
 * Env pattern: `ZAI_API_KEY` is set on `process.env` by tests (before
 * `buildRegistry`, which defaults its `env` option to `process.env`) and
 * restored afterwards. `buildRegistry({ env: {} })` exercises the no-key skip
 * without touching the environment at all.
 */
import { buildRegistry, createLogger, defaultConfig, type Logger } from "@airoute/core";
import { startGateway, type GatewayHandle } from "@airoute/gateway";
import { startMockProvider, type StartedMockProvider } from "@airoute/mock-provider";
import { createZaiSourceFactory } from "@airoute/zai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

let provider: StartedMockProvider | undefined;
let gateway: GatewayHandle | undefined;
let gatewayUrl: string;
const previousKey = process.env["ZAI_API_KEY"];

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

beforeAll(async () => {
  provider = await startMockProvider(); // echo scenario

  // Env-key gating runs against process.env (buildRegistry's default env).
  process.env["ZAI_API_KEY"] = "test";

  const config = defaultConfig();
  config.sources.registry = [
    {
      type: "zai",
      enabled: true,
      baseUrl: `${provider.url}/v1`, // mock chat = /v1/chat/completions
    },
  ];
  config.aliases["free-best"] = ["zai/glm-4.5-flash"];

  const build = await buildRegistry({
    config,
    factories: { zai: createZaiSourceFactory }, // same wiring as packages/cli/src/cli.ts
  });
  expect(build.enabled).toEqual(["zai"]);
  expect(build.skipped).toEqual([]);
  expect(build.disabled).toEqual([]);

  gateway = await startGateway({
    registry: build.registry,
    aliasMap: config.aliases,
    installShutdownHandlers: false,
    port: 0,
  });
  const address = gateway.server.address() as { port: number };
  gatewayUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await gateway?.stop();
  gateway = undefined;
  await provider?.close();
  provider = undefined;
  if (previousKey === undefined) delete process.env["ZAI_API_KEY"];
  else process.env["ZAI_API_KEY"] = previousKey;
});

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe("zai registry integration", () => {
  it("GET /v1/models advertises zai models through the gateway", async () => {
    const response = await fetch(`${gatewayUrl}/v1/models`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      object: string;
      data: Array<Record<string, unknown>>;
    };
    const zai = body.data.find((entry) => entry["id"] === "zai/glm-4.5-flash");
    expect(zai).toBeDefined();
    expect(zai?.["owned_by"]).toBe("zai");
    expect(zai?.["free"]).toBe(true);
    expect(zai?.["object"]).toBe("model");
    expect(body.data.some((entry) => entry["id"] === "zai/glm-4.5-air")).toBe(true);
  });

  it("POST non-stream chat completion routes gateway → zai source → mock provider", async () => {
    const response = await fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "zai/glm-4.5-flash",
        stream: false,
        messages: [{ role: "user", content: "phase1 e2e" }],
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      model: string;
      choices: Array<{ message: { role: string; content: string }; finish_reason: string }>;
    };
    expect(body.model).toBe("zai/glm-4.5-flash");
    expect(body.choices[0]!.message.role).toBe("assistant");
    expect(body.choices[0]!.message.content).toBe("ECHO: phase1 e2e");
    expect(body.choices[0]!.finish_reason).toBe("stop");
  });

  it("POST streaming chat completion delivers ordered SSE deltas then [DONE]", async () => {
    const response = await fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "zai/glm-4.5-flash",
        stream: true,
        messages: [{ role: "user", content: "phase1 stream" }],
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const stream = response.body;
    if (stream === null) throw new Error("no body");
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const payloads: string[] = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const boundary = buffer.indexOf("\n\n");
          if (boundary === -1) break;
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
          if (dataLine === undefined) continue;
          payloads.push(dataLine.slice("data: ".length).trim());
        }
      }
    } finally {
      void reader.cancel().catch(() => undefined);
    }

    expect(payloads.at(-1)).toBe("[DONE]");
    const chunks = payloads.slice(0, -1).map((payload) => JSON.parse(payload) as Record<string, unknown>);
    expect(chunks.length).toBeGreaterThan(2);

    const first = chunks[0]! as { choices: Array<{ delta: Record<string, unknown> }> };
    expect(first.choices[0]!.delta["role"]).toBe("assistant");

    const text = chunks
      .map(
        (chunk) =>
          ((chunk as { choices?: Array<{ delta?: { content?: unknown } }> }).choices?.[0]?.delta?.["content"] as string | undefined) ?? "",
      )
      .join("");
    expect(text).toBe("ECHO: phase1 stream");

    const last = chunks[chunks.length - 1]! as { choices: Array<{ finish_reason: string }> };
    expect(last.choices[0]!.finish_reason).toBe("stop");
  });

  it("the config alias bucket routes to the zai model", async () => {
    const response = await fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "free-best",
        messages: [{ role: "user", content: "alias e2e" }],
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0]!.message.content).toBe("ECHO: alias e2e");
  });
});

describe("zai registry gating", () => {
  it("self-skips without a key: enabled stays empty with reason 'no key'", async () => {
    const { logger, lines } = capturingLogger();
    const config = defaultConfig();
    config.sources.registry = [{ type: "zai", enabled: true }]; // matching the shipped config shape
    const build = await buildRegistry({
      config,
      factories: { zai: createZaiSourceFactory },
      env: { ZAI_API_KEY: undefined }, // no key → skip, no factory call
      logger,
    });
    expect(build.enabled).toEqual([]);
    expect(build.skipped).toEqual([{ type: "zai", reason: "no key" }]);
    expect(build.disabled).toEqual([]);
    const warns = lines.filter((line) => line.includes("disabled: no key"));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("source 'zai' disabled: no key (ZAI_API_KEY is not set)");
  });

  it("a malformed entry option reports failed-to-initialize, never a crash", async () => {
    const config = defaultConfig();
    config.sources.registry = [{ type: "zai", enabled: true, models: "definitely not an array" }];
    const build = await buildRegistry({
      config,
      factories: { zai: createZaiSourceFactory },
      env: { ZAI_API_KEY: "test" },
    });
    expect(build.enabled).toEqual([]);
    expect(build.skipped).toHaveLength(1);
    expect(build.skipped[0]!.type).toBe("zai");
    expect(build.skipped[0]!.reason).toContain("models");
  });
});
