/**
 * Capability-aware routing (Phase 4.5): tool requests skip tool-less
 * candidates, oversized prompts skip small-context candidates, and the error
 * explains each rejection. Loopback gateway, no external network.
 */
import { type AddressInfo } from "node:net";
import type { ReadableStream } from "node:stream/web";
import {
  createSourceRegistry,
  type IRChunk,
  type ModelSpec,
  type Source,
} from "@airoute/core";
import { startGateway, type GatewayHandle } from "@airoute/gateway";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

function spec(id: string, caps: { tools: boolean }, contextWindow: number): ModelSpec {
  return {
    id,
    sourceId: id.split("/")[0] as string,
    sourceModelId: id.split("/").slice(1).join("/"),
    label: id,
    contextWindow,
    caps: { tools: caps.tools, vision: false, reasoning: false },
    free: true,
    aliases: [],
  };
}

/** Replies with its own model id so the test can see which candidate served. */
function echoStream(text: string): ReadableStream<IRChunk> {
  return new ReadableStream<IRChunk>({
    start(controller) {
      controller.enqueue({ index: 0, role: "assistant" });
      controller.enqueue({ index: 1, content: text });
      controller.enqueue({ index: 2, finishReason: "stop", done: true });
      controller.close();
    },
  });
}

class EchoSource implements Source {
  constructor(
    readonly id: string,
    readonly specs: ModelSpec[],
  ) {}

  listModels(): Promise<ModelSpec[]> {
    return Promise.resolve(this.specs);
  }

  stream(request: { model: ModelSpec }): Promise<ReadableStream<IRChunk>> {
    return Promise.resolve(echoStream(request.model.id));
  }

  probe(): Promise<{ ok: boolean; at: string }> {
    return Promise.resolve({ ok: true, at: new Date().toISOString() });
  }
}

let gateway: GatewayHandle;
let baseUrl: string;

beforeAll(async () => {
  const registry = createSourceRegistry();
  // audio: can generate (huge context) but cannot call tools.
  registry.register(new EchoSource("audio", [spec("audio/gen", { tools: false }, 1_000_000)]));
  // tiny: tools yes, but a small context window.
  registry.register(new EchoSource("tiny", [spec("tiny/chat", { tools: true }, 1_000)]));
  // big: tools yes, large context.
  registry.register(new EchoSource("big", [spec("big/chat", { tools: true }, 100_000)]));

  gateway = await startGateway({
    registry,
    aliasMap: {
      "tools-mix": ["audio/gen", "tiny/chat", "big/chat"],
      "context-mix": ["tiny/chat", "big/chat"],
      "tools-only-audio": ["audio/gen"],
      "context-only-tiny": ["tiny/chat"],
    },
    // Preserve config order so the assertions target the filter, not ranking.
    ranker: (candidates) => candidates,
    installShutdownHandlers: false,
    port: 0,
  });
  baseUrl = `http://127.0.0.1:${(gateway.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await gateway?.stop();
});

const WEATHER_TOOL = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get the weather",
      parameters: { type: "object", properties: { city: { type: "string" } } },
    },
  },
];

async function post(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function chat(model: string, content: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { model, messages: [{ role: "user", content }], ...extra };
}

describe("capability-aware candidate filtering", () => {
  it("skips tool-less candidates for a tool request", async () => {
    const response = await post(chat("tools-mix", "hi", { tools: WEATHER_TOOL }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0]?.message.content).toBe("tiny/chat");
  });

  it("still routes a plain request to the first candidate", async () => {
    const response = await post(chat("tools-mix", "hi"));
    const body = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0]?.message.content).toBe("audio/gen");
  });

  it("skips candidates whose context cannot hold the prompt", async () => {
    // ~2500 estimated tokens vs tiny's 1000-token window.
    const longPrompt = "x".repeat(10_000);
    const response = await post(chat("context-mix", longPrompt));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0]?.message.content).toBe("big/chat");
  });

  it("returns an explained 503 when no candidate supports tools", async () => {
    const response = await post(chat("tools-only-audio", "hi", { tools: WEATHER_TOOL }));
    expect(response.status).toBe(503);
    const body = (await response.json()) as {
      error: {
        message: string;
        code: string;
        details?: { candidates?: Array<{ model: string; reason: string }> };
      };
    };
    expect(body.error.code).toBe("no_compatible_candidate");
    expect(body.error.message).toContain("tools_unsupported");
    expect(body.error.details?.candidates?.[0]).toMatchObject({
      model: "audio/gen",
      reason: "tools_unsupported",
    });
  });

  it("returns an explained 503 when the prompt exceeds every candidate", async () => {
    const response = await post(chat("context-only-tiny", "x".repeat(10_000)));
    expect(response.status).toBe(503);
    const body = (await response.json()) as {
      error: {
        code: string;
        message: string;
        details?: { estimated_prompt_tokens?: number; candidates?: Array<Record<string, unknown>> };
      };
    };
    expect(body.error.code).toBe("no_compatible_candidate");
    expect(body.error.message).toContain("context_too_small");
    expect(body.error.details?.estimated_prompt_tokens).toBeGreaterThan(1_000);
    expect(body.error.details?.candidates?.[0]).toMatchObject({
      model: "tiny/chat",
      reason: "context_too_small",
      context_window: 1_000,
    });
  });

  it("400s when an explicitly requested model cannot do what was asked", async () => {
    const response = await post(chat("audio/gen", "hi", { tools: WEATHER_TOOL }));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("model_incompatible");
    expect(body.error.message).toContain("does not support tool calling");
  });
});
